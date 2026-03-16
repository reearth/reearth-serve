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
)

// ExtractionConfig holds configuration for the extraction worker.
type ExtractionConfig struct {
	AssetID         string
	ArchiveKey      string // storage key for the archive file
	ArchiveFilename string // original filename (for root prefix detection)
	ArchiveFormat   string // "zip", "tar", "tar.gz"
	WorkerAPIURL    string // Worker API base URL for status updates
	MaxConcurrency  int    // max parallel uploads (default: 48)
	CheckpointEvery int    // checkpoint interval in entries (default: 100)
}

// ExtractionWorker orchestrates the extraction of an archive to object storage.
type ExtractionWorker struct {
	cfg        ExtractionConfig
	storage    ObjectStorage
	checkpoint *CheckpointManager
	manifest   *ManifestWriter
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

	entries, err := extractor.ListEntries(ctx)
	if err != nil {
		return fmt.Errorf("failed to list entries: %w", err)
	}

	rootPrefix := DetectRootPrefix(entries, w.cfg.ArchiveFilename)
	cp.RootPrefix = rootPrefix

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	fileCount := 0
	for i := range entries {
		normalized := NormalizeSeparators(entries[i].Path)
		normalized = StripPrefix(normalized, rootPrefix)
		entries[i].NormalizedPath = normalized
		if err := enc.Encode(entries[i]); err != nil {
			return fmt.Errorf("failed to encode entry %d: %w", i, err)
		}
		if !entries[i].IsDirectory {
			fileCount++
		}
	}

	if err := w.storage.PutObject(ctx, entryListKey, bytes.NewReader(buf.Bytes()), int64(buf.Len()), "application/x-ndjson", nil); err != nil {
		return fmt.Errorf("failed to write entry list: %w", err)
	}

	cp.Phase = "entries_listed"
	cp.TotalEntries = fileCount
	if err := w.checkpoint.Save(ctx, cp); err != nil {
		return fmt.Errorf("failed to save checkpoint: %w", err)
	}

	log.Printf("phase A: listed %d entries (%d files), rootPrefix=%q", len(entries), fileCount, rootPrefix)
	return nil
}

func (w *ExtractionWorker) phaseB(ctx context.Context, cp *JobCheckpoint) error {
	cp.Phase = "extracting"

	entries, err := w.loadEntryList(ctx)
	if err != nil {
		return err
	}

	extractor, err := w.createExtractor(ctx)
	if err != nil {
		return err
	}

	sem := make(chan struct{}, w.cfg.MaxConcurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup
	var extractErr atomic.Value
	chunkIndex := cp.ManifestChunksWritten
	resumeAfter := cp.LastProcessedIndex

	for _, entry := range entries {
		if entry.IsDirectory {
			continue
		}
		if entry.Index <= resumeAfter {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		if extractErr.Load() != nil {
			break
		}

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
			cp.LastProcessedIndex = e.Index

			if err := w.manifest.Add(ctx, fe, &chunkIndex); err != nil {
				log.Printf("failed to add manifest entry: %v", err)
			}

			if cp.ProcessedCount%w.cfg.CheckpointEvery == 0 {
				cp.ManifestChunksWritten = chunkIndex
				if err := w.checkpoint.Save(ctx, cp); err != nil {
					log.Printf("failed to save checkpoint: %v", err)
				}
				log.Printf("checkpoint: %d/%d files processed", cp.ProcessedCount, cp.TotalEntries)

				// Report progress
				_ = w.updateJobStatus(ctx, "running", cp.ProcessedCount, cp.ProcessedBytes)

				// Check if asset still exists (TTL may have expired)
				if !w.checkAssetExists(ctx) {
					log.Printf("asset %s no longer exists (TTL expired), aborting extraction", w.cfg.AssetID)
					extractErr.Store(fmt.Errorf("asset expired during extraction"))
				}
			}
			mu.Unlock()
		}(entry)
	}

	wg.Wait()

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

func (w *ExtractionWorker) phaseC(ctx context.Context, cp *JobCheckpoint) error {
	log.Println("phase C: finalizing manifest...")

	if err := w.manifest.Finalize(ctx, cp.ManifestChunksWritten); err != nil {
		return fmt.Errorf("failed to finalize manifest: %w", err)
	}

	entryListKey := fmt.Sprintf("assets/%s/_archive/_entry_list.jsonl", w.cfg.AssetID)
	_ = w.storage.DeleteObject(ctx, entryListKey)

	if err := w.updateJobStatus(ctx, "completed", cp.ProcessedCount, cp.ProcessedBytes); err != nil {
		log.Printf("warning: failed to update job status: %v", err)
	}

	cp.Phase = "completed"
	_ = w.checkpoint.Delete(ctx)

	log.Println("phase C: complete")
	return nil
}

func (w *ExtractionWorker) extractAndUpload(ctx context.Context, extractor ArchiveExtractor, entry ArchiveEntry) (string, error) {
	rc, err := extractor.ExtractEntry(ctx, entry)
	if err != nil {
		return "", fmt.Errorf("extract: %w", err)
	}
	defer func() { _ = rc.Close() }()

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
		// Uncompressed: use size from ZIP central directory
		contentLength = entry.Size
	}

	if err := w.storage.PutObject(ctx, r2Key, body, contentLength, contentType, opts); err != nil {
		return "", fmt.Errorf("upload: %w", err)
	}

	return fmt.Sprintf("md5:%x", hash.Sum(nil)), nil
}

func (w *ExtractionWorker) loadEntryList(ctx context.Context) ([]ArchiveEntry, error) {
	key := fmt.Sprintf("assets/%s/_archive/_entry_list.jsonl", w.cfg.AssetID)
	body, err := w.storage.GetObject(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("failed to get entry list: %w", err)
	}
	defer func() { _ = body.Close() }()

	var entries []ArchiveEntry
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var e ArchiveEntry
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			return nil, fmt.Errorf("failed to unmarshal entry: %w", err)
		}
		entries = append(entries, e)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to scan entry list: %w", err)
	}
	return entries, nil
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

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return true // assume exists on network error
	}
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode != http.StatusNotFound
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

	resp, err := http.DefaultClient.Do(req)
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
