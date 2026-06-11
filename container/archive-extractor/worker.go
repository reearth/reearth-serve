package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// workerAPITimeout caps every callback to the Worker API. http.DefaultClient
// has no timeout, which previously let a slow/hung Worker freeze the in-flight
// extraction (the call was made under the progress mutex, blocking every
// upload goroutine).
const workerAPITimeout = 30 * time.Second

// ExtractionConfig holds configuration for the extraction worker.
type ExtractionConfig struct {
	AssetID           string
	ArchiveKey        string // storage key for the archive file
	ArchiveFilename   string // original filename (for root prefix detection)
	ArchiveFormat     string // "zip", "tar", "tar.gz"
	WorkerAPIURL      string // Worker API base URL for status updates
	InternalAPISecret string // shared bearer secret for /api/internal/* callbacks
	MaxConcurrency    int    // max parallel uploads (default: 48)
	CheckpointEvery   int    // checkpoint interval in entries (default: 100)
}

// ExtractionWorker orchestrates the extraction of an archive to object storage.
type ExtractionWorker struct {
	cfg        ExtractionConfig
	storage    ObjectStorage
	checkpoint *CheckpointManager
	manifest   *ManifestWriter
	httpClient *http.Client
}

// NewExtractionWorker creates a new ExtractionWorker.
func NewExtractionWorker(storage ObjectStorage, cfg ExtractionConfig) *ExtractionWorker {
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = 48
	}
	if cfg.CheckpointEvery <= 0 {
		cfg.CheckpointEvery = 100
	}

	return &ExtractionWorker{
		cfg:        cfg,
		storage:    storage,
		checkpoint: NewCheckpointManager(storage, cfg.AssetID),
		manifest:   NewManifestWriter(storage, cfg.AssetID),
		httpClient: &http.Client{Timeout: workerAPITimeout},
	}
}

// Run executes the extraction with resume support.
func (w *ExtractionWorker) Run(ctx context.Context) error {
	cp, err := w.checkpoint.Load(ctx)
	if err != nil {
		return fmt.Errorf("failed to load checkpoint: %w", err)
	}
	if cp == nil {
		cp = &JobCheckpoint{
			Phase:              "entries_listing",
			LastProcessedIndex: -1,
		}
	}

	log.Printf("starting extraction: assetId=%s format=%s phase=%s lastIndex=%d",
		w.cfg.AssetID, w.cfg.ArchiveFormat, cp.Phase, cp.LastProcessedIndex)

	// Report running status (totalFiles will be set after phaseA)
	_ = w.updateJobStatus(ctx, "running", 0, 0)

	if cp.Phase == "entries_listing" || cp.Phase == "" {
		if err := w.phaseA(ctx, cp); err != nil {
			return fmt.Errorf("phase A (list entries): %w", err)
		}
		log.Printf("phase A complete: totalEntries=%d rootPrefix=%q", cp.TotalEntries, cp.RootPrefix)
		_ = w.updateJobStatus(ctx, "running", 0, 0, withTotalFiles(cp.TotalEntries))
	}

	if cp.Phase == "entries_listed" || cp.Phase == "extracting" {
		if err := w.phaseB(ctx, cp); err != nil {
			return fmt.Errorf("phase B (extract): %w", err)
		}
		log.Printf("phase B complete: processedCount=%d processedBytes=%d errors=%d", cp.ProcessedCount, cp.ProcessedBytes, len(cp.Errors))
	}

	if cp.Phase == "completing" {
		if err := w.phaseC(ctx, cp); err != nil {
			return fmt.Errorf("phase C (finalize): %w", err)
		}
	}

	log.Printf("extraction completed: %d files, %d bytes", cp.ProcessedCount, cp.ProcessedBytes)
	return nil
}

func (w *ExtractionWorker) phaseA(ctx context.Context, cp *JobCheckpoint) error {
	entryListKey := fmt.Sprintf("assets/%s/_archive/_entry_list.jsonl", w.cfg.AssetID)
	if _, err := w.storage.HeadObject(ctx, entryListKey); err == nil {
		log.Println("phase A: entry list already exists, skipping")
		cp.Phase = "entries_listed"
		return nil
	}

	log.Println("phase A: listing entries...")

	extractor, err := w.createExtractor(ctx)
	if err != nil {
		return err
	}

	// Stream entries straight into R2 via io.Pipe instead of materializing a
	// []ArchiveEntry + JSON bytes.Buffer in memory. A 500k-entry archive
	// previously allocated ~100 MB for each, enough to OOM the default
	// 256 MiB container. We also skip pre-computing NormalizedPath here —
	// phaseB/phaseBSequential derive it on the fly from cp.RootPrefix.
	pr, pw := io.Pipe()
	detector := &RootPrefixDetector{}
	fileCount := 0
	listDone := make(chan error, 1)

	go func() {
		enc := json.NewEncoder(pw)
		err := extractor.ListEntries(ctx, func(entry ArchiveEntry) error {
			detector.Observe(entry.Path)
			if !entry.IsDirectory {
				fileCount++
			}
			return enc.Encode(entry)
		})
		// Close (with error if any) so the reader side unblocks.
		_ = pw.CloseWithError(err)
		listDone <- err
	}()

	putErr := w.storage.PutObject(ctx, entryListKey, pr, -1, "application/x-ndjson", nil)
	listErr := <-listDone
	if listErr != nil {
		// Abandon any partial object — phaseA re-runs will start clean.
		_ = w.storage.DeleteObject(ctx, entryListKey)
		return fmt.Errorf("failed to list entries: %w", listErr)
	}
	if putErr != nil {
		_ = w.storage.DeleteObject(ctx, entryListKey)
		return fmt.Errorf("failed to write entry list: %w", putErr)
	}

	cp.Phase = "entries_listed"
	cp.TotalEntries = fileCount
	cp.RootPrefix = detector.Result(w.cfg.ArchiveFilename)
	if err := w.checkpoint.Save(ctx, cp); err != nil {
		return fmt.Errorf("failed to save checkpoint: %w", err)
	}

	log.Printf("phase A: listed %d files, rootPrefix=%q", fileCount, cp.RootPrefix)
	return nil
}

func (w *ExtractionWorker) phaseB(ctx context.Context, cp *JobCheckpoint) error {
	cp.Phase = "extracting"

	extractor, err := w.createExtractor(ctx)
	if err != nil {
		return err
	}

	// Formats without random access (tar, tar.gz) take a sequential path so
	// we open and decompress the archive once instead of N times. Both
	// paths stream the entry list from R2 so we never hold the full
	// []ArchiveEntry in memory.
	if seq, ok := extractor.(SequentialExtractor); ok {
		return w.phaseBSequential(ctx, cp, seq)
	}

	sem := make(chan struct{}, w.cfg.MaxConcurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup
	var extractErr atomic.Value
	chunkIndex := cp.ManifestChunksWritten
	resumeAfter := cp.LastProcessedIndex
	rootPrefix := cp.RootPrefix
	lastStatusAt := time.Now()

	// Resume low-water mark. Goroutines complete out of index order, so the
	// highest finished index is NOT safe to persist as LastProcessedIndex: a
	// crash would make resume skip lower-indexed entries that were still in
	// flight (observed as files missing after a deploy-rollout resume). Track
	// the contiguous prefix of settled indexes instead and only persist that.
	// Directories and resume-skipped entries settle immediately; extracted
	// and errored entries settle on completion.
	loWater := resumeAfter
	settled := make(map[int]struct{})
	settle := func(idx int) {
		settled[idx] = struct{}{}
		for {
			if _, ok := settled[loWater+1]; !ok {
				break
			}
			delete(settled, loWater+1)
			loWater++
		}
	}

	err = w.streamEntryList(ctx, func(entry ArchiveEntry) error {
		if entry.IsDirectory {
			mu.Lock()
			settle(entry.Index)
			mu.Unlock()
			return nil
		}
		if entry.Index <= resumeAfter {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if extractErr.Load() != nil {
			return fmt.Errorf("aborting: prior extraction error")
		}

		// Compute the normalized path on the fly so the JSONL can stay
		// raw (smaller, simpler — see phaseA). The goroutine below uses
		// e.NormalizedPath for storage keys and manifest entries.
		entry.NormalizedPath = StripPrefix(NormalizeSeparators(entry.Path), rootPrefix)

		sem <- struct{}{}
		wg.Add(1)

		go func(e ArchiveEntry) {
			defer wg.Done()
			defer func() { <-sem }()

			fileHash, err := w.extractAndUpload(ctx, extractor, e)
			if err != nil {
				log.Printf("error extracting %q: %v", e.NormalizedPath, err)
				mu.Lock()
				cp.Errors = append(cp.Errors, EntryError{
					Index: e.Index,
					Path:  e.NormalizedPath,
					Error: err.Error(),
				})
				settle(e.Index)
				mu.Unlock()
				return
			}

			fe := FileEntry{
				Path:        e.NormalizedPath,
				Size:        e.Size,
				ContentType: DetectContentType(e.NormalizedPath),
				Hash:        fileHash,
			}
			if ShouldCompress(e.NormalizedPath, e.Size) {
				fe.ContentEncoding = "gzip"
			}

			mu.Lock()
			cp.ProcessedCount++
			cp.ProcessedBytes += e.Size
			settle(e.Index)
			// Persist only the contiguous low-water mark: entries above it
			// may still be in flight, and resume skips everything ≤ this
			// index.
			cp.LastProcessedIndex = loWater

			if err := w.manifest.Add(ctx, fe, &chunkIndex); err != nil {
				log.Printf("failed to add manifest entry: %v", err)
			}

			// Snapshot the values needed for the checkpoint/callback so we
			// can release the lock before doing slow R2/HTTP I/O. Holding
			// the mutex across those calls previously froze every other
			// upload goroutine when the Worker API hung.
			doCheckpoint := cp.ProcessedCount%w.cfg.CheckpointEvery == 0 ||
				time.Since(lastStatusAt) >= statusUpdateInterval
			if doCheckpoint {
				lastStatusAt = time.Now()
				// Flush the in-memory manifest buffer (even partially full)
				// before the checkpoint records ManifestChunksWritten — a
				// checkpoint that claims more progress than the persisted
				// manifest chunks loses every buffered entry on restart
				// (observed: a resumed 595-file extraction finished with a
				// 406-line manifest).
				if err := w.manifest.FlushChunk(ctx, &chunkIndex); err != nil {
					log.Printf("failed to flush manifest chunk at checkpoint: %v", err)
				}
				cp.ManifestChunksWritten = chunkIndex
			}
			processedCount := cp.ProcessedCount
			processedBytes := cp.ProcessedBytes
			totalEntries := cp.TotalEntries
			cpSnapshot := *cp
			mu.Unlock()

			if doCheckpoint {
				if err := w.checkpoint.Save(ctx, &cpSnapshot); err != nil {
					log.Printf("failed to save checkpoint: %v", err)
				}
				log.Printf("checkpoint: %d/%d files processed", processedCount, totalEntries)

				// Report progress
				_ = w.updateJobStatus(ctx, "running", processedCount, processedBytes)

				// Check if asset still exists (TTL may have expired)
				if !w.checkAssetExists(ctx) {
					log.Printf("asset %s no longer exists (TTL expired), aborting extraction", w.cfg.AssetID)
					extractErr.Store(fmt.Errorf("asset expired during extraction"))
				}
			}
		}(entry)
		return nil
	})

	// Wait for all in-flight uploads before reporting list-time errors.
	wg.Wait()
	if err != nil {
		return fmt.Errorf("failed to stream entry list: %w", err)
	}

	if err := w.manifest.FlushChunk(ctx, &chunkIndex); err != nil {
		return fmt.Errorf("failed to flush final manifest chunk: %w", err)
	}

	cp.Phase = "completing"
	cp.ManifestChunksWritten = chunkIndex
	if err := w.checkpoint.Save(ctx, cp); err != nil {
		return fmt.Errorf("failed to save checkpoint: %w", err)
	}

	if errVal := extractErr.Load(); errVal != nil {
		return errVal.(error)
	}

	log.Printf("phase B: extracted %d files, %d errors", cp.ProcessedCount, len(cp.Errors))
	return nil
}

// phaseBSequential extracts a single-pass archive (tar/tar.gz) in order.
// The archive is opened once; uploads happen synchronously per entry.
// This is slower than the parallel path but avoids the O(N²) re-scan that
// the random-access ExtractEntry path would force on tar formats.
func (w *ExtractionWorker) phaseBSequential(ctx context.Context, cp *JobCheckpoint, ext SequentialExtractor) error {
	chunkIndex := cp.ManifestChunksWritten
	resumeAfter := cp.LastProcessedIndex
	rootPrefix := cp.RootPrefix
	lastStatusAt := time.Now()

	err := ext.ExtractAllSequential(ctx, func(rawEntry ArchiveEntry, r io.Reader) error {
		// Normalize the path from the tar header on the fly instead of
		// looking it up in a pre-built map (phaseA no longer buffers the
		// entry list).
		e := rawEntry
		e.NormalizedPath = StripPrefix(NormalizeSeparators(rawEntry.Path), rootPrefix)

		if e.IsDirectory {
			_, _ = io.Copy(io.Discard, r)
			return nil
		}
		// Skip already-processed entries on resume. We still need to drain
		// their bytes so the underlying tar reader advances to the next header.
		if e.Index <= resumeAfter {
			_, _ = io.Copy(io.Discard, r)
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		fileHash, err := w.uploadFromReader(ctx, e, r)
		if err != nil {
			log.Printf("error extracting %q: %v", e.NormalizedPath, err)
			cp.Errors = append(cp.Errors, EntryError{
				Index: e.Index,
				Path:  e.NormalizedPath,
				Error: err.Error(),
			})
			return nil // continue with the next entry
		}

		fe := FileEntry{
			Path:        e.NormalizedPath,
			Size:        e.Size,
			ContentType: DetectContentType(e.NormalizedPath),
			Hash:        fileHash,
		}
		if ShouldCompress(e.NormalizedPath, e.Size) {
			fe.ContentEncoding = "gzip"
		}

		cp.ProcessedCount++
		cp.ProcessedBytes += e.Size
		cp.LastProcessedIndex = e.Index
		if err := w.manifest.Add(ctx, fe, &chunkIndex); err != nil {
			log.Printf("failed to add manifest entry: %v", err)
		}

		if cp.ProcessedCount%w.cfg.CheckpointEvery == 0 ||
			time.Since(lastStatusAt) >= statusUpdateInterval {
			lastStatusAt = time.Now()
			// Persist buffered manifest entries before the checkpoint claims
			// them as written (see the parallel path for the failure mode).
			if err := w.manifest.FlushChunk(ctx, &chunkIndex); err != nil {
				log.Printf("failed to flush manifest chunk at checkpoint: %v", err)
			}
			cp.ManifestChunksWritten = chunkIndex
			if err := w.checkpoint.Save(ctx, cp); err != nil {
				log.Printf("failed to save checkpoint: %v", err)
			}
			log.Printf("checkpoint: %d/%d files processed", cp.ProcessedCount, cp.TotalEntries)
			_ = w.updateJobStatus(ctx, "running", cp.ProcessedCount, cp.ProcessedBytes)
			if !w.checkAssetExists(ctx) {
				return fmt.Errorf("asset expired during extraction")
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	if err := w.manifest.FlushChunk(ctx, &chunkIndex); err != nil {
		return fmt.Errorf("failed to flush final manifest chunk: %w", err)
	}

	cp.Phase = "completing"
	cp.ManifestChunksWritten = chunkIndex
	if err := w.checkpoint.Save(ctx, cp); err != nil {
		return fmt.Errorf("failed to save checkpoint: %w", err)
	}

	log.Printf("phase B (sequential): extracted %d files, %d errors", cp.ProcessedCount, len(cp.Errors))
	return nil
}

func (w *ExtractionWorker) phaseC(ctx context.Context, cp *JobCheckpoint) error {
	log.Println("phase C: finalizing manifest...")

	if err := w.manifest.Finalize(ctx, cp.ManifestChunksWritten); err != nil {
		return fmt.Errorf("failed to finalize manifest: %w", err)
	}

	entryListKey := fmt.Sprintf("assets/%s/_archive/_entry_list.jsonl", w.cfg.AssetID)
	_ = w.storage.DeleteObject(ctx, entryListKey)

	// Surface partial failures on the otherwise-completed job. Before this,
	// entries that exhausted their retries were only visible in the R2 log —
	// the job reported plain "completed" and the missing files went unnoticed.
	var opts []jobStatusOption
	if n := len(cp.Errors); n > 0 {
		first := cp.Errors[0]
		opts = append(opts, withError(fmt.Sprintf("%d of %d entries failed to extract; first: %s: %s", n, cp.TotalEntries, first.Path, first.Error)))
	}
	if err := w.updateJobStatus(ctx, "completed", cp.ProcessedCount, cp.ProcessedBytes, opts...); err != nil {
		log.Printf("warning: failed to update job status: %v", err)
	}

	cp.Phase = "completed"
	_ = w.checkpoint.Delete(ctx)

	log.Println("phase C: complete")
	return nil
}

// statusUpdateInterval forces a checkpoint + status update even when fewer
// than CheckpointEvery entries completed. Large entries make count-based
// checkpoints arbitrarily sparse (100 multi-GB files can span an hour), and
// the cleanup cron uses the job's updated_at to tell a working extraction
// from one whose container died (e.g. killed by a deploy rollout). Frequent
// heartbeats let the stuck threshold be minutes instead of a day.
const statusUpdateInterval = 2 * time.Minute

// extractEntryAttempts bounds per-entry retries. Multi-GB entries hold their
// archive range-GET open for however long the decompress+reupload pipeline
// takes; R2 occasionally drops those long-lived connections mid-stream
// ("unexpected EOF" from flate), and without a retry the entry was recorded
// as a permanent error and silently missing from the extracted asset.
const extractEntryAttempts = 3

func (w *ExtractionWorker) extractAndUpload(ctx context.Context, extractor ArchiveExtractor, entry ArchiveEntry) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= extractEntryAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		hash, err := func() (string, error) {
			rc, err := extractor.ExtractEntry(ctx, entry)
			if err != nil {
				return "", fmt.Errorf("extract: %w", err)
			}
			defer func() { _ = rc.Close() }()
			return w.uploadFromReader(ctx, entry, rc)
		}()
		if err == nil {
			return hash, nil
		}
		lastErr = err
		if attempt < extractEntryAttempts {
			log.Printf("retrying %q (attempt %d/%d) after error: %v", entry.NormalizedPath, attempt+1, extractEntryAttempts, err)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
	}
	return "", lastErr
}

// uploadFromReader uploads a single entry's bytes to storage. Caller owns
// the reader's lifetime; this function only consumes from it. Used by both
// the parallel ExtractEntry path and the sequential ExtractAllSequential path.
func (w *ExtractionWorker) uploadFromReader(ctx context.Context, entry ArchiveEntry, rc io.Reader) (string, error) {
	r2Key := fmt.Sprintf("assets/%s/files/%s", w.cfg.AssetID, entry.NormalizedPath)
	contentType := DetectContentType(entry.NormalizedPath)

	// Compute MD5 while streaming the uncompressed data
	hash := md5.New()
	body := io.Reader(io.TeeReader(rc, hash))
	var opts *PutOptions
	var contentLength int64

	if ShouldCompress(entry.NormalizedPath, entry.Size) {
		// Gzip compressed: size unknown upfront, use -1 to trigger multipart upload
		body = GzipReader(body)
		opts = &PutOptions{ContentEncoding: "gzip"}
		contentLength = -1
	} else {
		// Uncompressed: use size from archive metadata
		contentLength = entry.Size
	}

	if err := w.storage.PutObject(ctx, r2Key, body, contentLength, contentType, opts); err != nil {
		return "", fmt.Errorf("upload: %w", err)
	}

	return fmt.Sprintf("md5:%x", hash.Sum(nil)), nil
}

// streamEntryList reads the JSONL entry list from R2 and yields each entry
// through the callback. Unlike a slice-returning loader, peak memory stays
// at one line of JSON, which is what prevents phaseB from doubling the
// worst-case allocation phaseA already had to trim.
func (w *ExtractionWorker) streamEntryList(ctx context.Context, yield func(entry ArchiveEntry) error) error {
	key := fmt.Sprintf("assets/%s/_archive/_entry_list.jsonl", w.cfg.AssetID)
	body, err := w.storage.GetObject(ctx, key)
	if err != nil {
		return fmt.Errorf("failed to get entry list: %w", err)
	}
	defer func() { _ = body.Close() }()

	scanner := bufio.NewScanner(body)
	// Individual entries can be large (long Unicode paths); cap matches the
	// previous loader so we stay bug-compatible on pathological filenames.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var e ArchiveEntry
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			return fmt.Errorf("failed to unmarshal entry: %w", err)
		}
		if err := yield(e); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("failed to scan entry list: %w", err)
	}
	return nil
}

func (w *ExtractionWorker) createExtractor(ctx context.Context) (ArchiveExtractor, error) {
	switch w.cfg.ArchiveFormat {
	case "zip":
		return NewZipExtractor(ctx, w.storage, w.cfg.ArchiveKey)
	case "tar":
		return NewTarExtractor(w.storage, w.cfg.ArchiveKey, false), nil
	case "tar.gz", "tgz":
		return NewTarExtractor(w.storage, w.cfg.ArchiveKey, true), nil
	default:
		return nil, fmt.Errorf("unsupported archive format: %s", w.cfg.ArchiveFormat)
	}
}

// checkAssetExists checks if the asset still exists via the Worker API.
// Returns false if the asset's TTL has expired (404 from API).
func (w *ExtractionWorker) checkAssetExists(ctx context.Context) bool {
	if w.cfg.WorkerAPIURL == "" {
		return true
	}

	url := strings.TrimRight(w.cfg.WorkerAPIURL, "/") + fmt.Sprintf("/api/internal/assets/%s/exists", w.cfg.AssetID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return true // assume exists on error
	}
	w.setAuthHeader(req)

	resp, err := w.httpClient.Do(req)
	if err != nil {
		return true // assume exists on network error
	}
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode != http.StatusNotFound
}

// setAuthHeader attaches the shared bearer secret expected by /api/internal/*.
func (w *ExtractionWorker) setAuthHeader(req *http.Request) {
	if w.cfg.InternalAPISecret != "" {
		req.Header.Set("Authorization", "Bearer "+w.cfg.InternalAPISecret)
	}
}

type jobStatusPayload struct {
	Status        string `json:"status"`
	TotalFiles    int    `json:"totalFiles,omitempty"`
	FileCount     int    `json:"fileCount"`
	ExtractedSize int64  `json:"extractedSize"`
	Error         string `json:"error,omitempty"`
}

type jobStatusOption func(*jobStatusPayload)

func withTotalFiles(n int) jobStatusOption {
	return func(p *jobStatusPayload) { p.TotalFiles = n }
}

func withError(msg string) jobStatusOption {
	return func(p *jobStatusPayload) { p.Error = msg }
}

func (w *ExtractionWorker) updateJobStatus(ctx context.Context, status string, fileCount int, extractedBytes int64, opts ...jobStatusOption) error {
	if w.cfg.WorkerAPIURL == "" {
		return nil
	}

	p := jobStatusPayload{
		Status:        status,
		FileCount:     fileCount,
		ExtractedSize: extractedBytes,
	}
	for _, opt := range opts {
		opt(&p)
	}

	payload, _ := json.Marshal(p)

	url := strings.TrimRight(w.cfg.WorkerAPIURL, "/") + fmt.Sprintf("/api/internal/jobs/%s/status", w.cfg.AssetID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	w.setAuthHeader(req)

	resp, err := w.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("worker API returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}
