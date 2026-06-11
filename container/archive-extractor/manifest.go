package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"path/filepath"
	"strings"
)

// FileEntry represents a single extracted file in the manifest.
type FileEntry struct {
	Path            string `json:"path"`
	Size            int64  `json:"size"`
	ContentType     string `json:"contentType"`
	ContentEncoding string `json:"contentEncoding,omitempty"`
	Hash            string `json:"hash,omitempty"` // "md5:<hex>"
}

// ManifestWriter manages writing manifest chunks and the final manifest to storage.
type ManifestWriter struct {
	storage ObjectStorage
	assetID string
	chunk   []FileEntry
}

// NewManifestWriter creates a new ManifestWriter.
func NewManifestWriter(storage ObjectStorage, assetID string) *ManifestWriter {
	return &ManifestWriter{storage: storage, assetID: assetID}
}

const manifestChunkSize = 1000

// Add adds a file entry. When the buffer reaches manifestChunkSize,
// it automatically flushes to storage as a chunk.
func (mw *ManifestWriter) Add(ctx context.Context, entry FileEntry, chunkIndex *int) error {
	mw.chunk = append(mw.chunk, entry)
	if len(mw.chunk) >= manifestChunkSize {
		return mw.FlushChunk(ctx, chunkIndex)
	}
	return nil
}

// FlushChunk writes the current buffer as a manifest chunk to storage.
func (mw *ManifestWriter) FlushChunk(ctx context.Context, chunkIndex *int) error {
	if len(mw.chunk) == 0 {
		return nil
	}

	key := fmt.Sprintf("assets/%s/_archive/_manifest_chunks/%06d.jsonl", mw.assetID, *chunkIndex)
	data := encodeJSONL(mw.chunk)

	if err := mw.storage.PutObject(ctx, key, bytes.NewReader(data), int64(len(data)), "application/x-ndjson", nil); err != nil {
		return fmt.Errorf("failed to write manifest chunk %d: %w", *chunkIndex, err)
	}

	*chunkIndex++
	mw.chunk = mw.chunk[:0]
	return nil
}

// Finalize combines all manifest chunks into the final _manifest.jsonl.
//
// Chunks are streamed sequentially through an io.Pipe into a single
// PutObject with an unknown content length (size=-1 → multipart). The
// previous implementation io.ReadAll'd every chunk into one bytes.Buffer
// before uploading, which defeated the chunked write entirely: a 500k-file
// archive produces a ~100 MB manifest, and holding it all in RAM on top of
// any other phase-C state OOM'd the default 256 MiB container — on the
// exact workload the chunking was designed to support.
//
// Lines are deduplicated by path while streaming: a resumed extraction
// re-processes entries between the checkpoint's low-water mark and the
// indexes that had already completed, so the same path can appear in two
// chunks. The seen-set costs ~50 bytes per file (25 MB for a 500k-file
// archive), well within the standard-2 container.
func (mw *ManifestWriter) Finalize(ctx context.Context, totalChunks int) error {
	finalKey := fmt.Sprintf("assets/%s/_archive/_manifest.jsonl", mw.assetID)

	pr, pw := io.Pipe()
	go func() {
		seen := make(map[string]struct{})
		for i := range totalChunks {
			if err := ctx.Err(); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			key := fmt.Sprintf("assets/%s/_archive/_manifest_chunks/%06d.jsonl", mw.assetID, i)
			body, err := mw.storage.GetObject(ctx, key)
			if err != nil {
				_ = pw.CloseWithError(fmt.Errorf("failed to read manifest chunk %d: %w", i, err))
				return
			}
			scanner := bufio.NewScanner(body)
			scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
			var copyErr error
			for scanner.Scan() {
				line := scanner.Bytes()
				var e struct {
					Path string `json:"path"`
				}
				if err := json.Unmarshal(line, &e); err == nil && e.Path != "" {
					if _, dup := seen[e.Path]; dup {
						continue
					}
					seen[e.Path] = struct{}{}
				}
				if _, err := pw.Write(append(line, '\n')); err != nil {
					copyErr = err
					break
				}
			}
			if copyErr == nil {
				copyErr = scanner.Err()
			}
			_ = body.Close()
			if copyErr != nil {
				_ = pw.CloseWithError(fmt.Errorf("failed to copy manifest chunk %d: %w", i, copyErr))
				return
			}
		}
		_ = pw.Close()
	}()

	if err := mw.storage.PutObject(ctx, finalKey, pr, -1, "application/x-ndjson", nil); err != nil {
		// Drain the pipe so the producer goroutine unblocks before we return.
		_ = pr.CloseWithError(err)
		return fmt.Errorf("failed to write final manifest: %w", err)
	}

	// Only drop the chunk objects after the final manifest upload succeeded
	// — keeping them lets Finalize be safely retried on upload failure.
	for i := range totalChunks {
		key := fmt.Sprintf("assets/%s/_archive/_manifest_chunks/%06d.jsonl", mw.assetID, i)
		_ = mw.storage.DeleteObject(ctx, key)
	}

	return nil
}

func encodeJSONL(entries []FileEntry) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, e := range entries {
		_ = enc.Encode(e)
	}
	return buf.Bytes()
}

// DetectContentType returns a MIME type for a filename based on its extension.
func DetectContentType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))

	known := map[string]string{
		".geojson":  "application/geo+json",
		".topojson": "application/json",
		".pbf":      "application/x-protobuf",
		".mvt":      "application/vnd.mapbox-vector-tile",
		".kml":      "application/vnd.google-earth.kml+xml",
		".kmz":      "application/vnd.google-earth.kmz",
		".gml":      "application/gml+xml",
		".czml":     "application/json",
		".glb":      "model/gltf-binary",
		".gltf":     "model/gltf+json",
		".b3dm":     "application/octet-stream",
		".pnts":     "application/octet-stream",
		".i3dm":     "application/octet-stream",
		".cmpt":     "application/octet-stream",
		".terrain":  "application/vnd.quantized-mesh",
		".tif":      "image/tiff",
		".tiff":     "image/tiff",
		".webp":     "image/webp",
	}

	if ct, ok := known[ext]; ok {
		return ct
	}

	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}

	return "application/octet-stream"
}
