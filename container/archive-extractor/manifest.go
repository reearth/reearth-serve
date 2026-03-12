package main

import (
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

	if err := mw.storage.PutObject(ctx, key, bytes.NewReader(data), "application/x-ndjson", nil); err != nil {
		return fmt.Errorf("failed to write manifest chunk %d: %w", *chunkIndex, err)
	}

	*chunkIndex++
	mw.chunk = mw.chunk[:0]
	return nil
}

// Finalize combines all manifest chunks into the final _manifest.jsonl.
func (mw *ManifestWriter) Finalize(ctx context.Context, totalChunks int) error {
	var all bytes.Buffer

	for i := range totalChunks {
		key := fmt.Sprintf("assets/%s/_archive/_manifest_chunks/%06d.jsonl", mw.assetID, i)
		body, err := mw.storage.GetObject(ctx, key)
		if err != nil {
			return fmt.Errorf("failed to read manifest chunk %d: %w", i, err)
		}
		data, err := io.ReadAll(body)
		_ = body.Close()
		if err != nil {
			return fmt.Errorf("failed to read manifest chunk %d data: %w", i, err)
		}
		all.Write(data)
	}

	finalKey := fmt.Sprintf("assets/%s/_archive/_manifest.jsonl", mw.assetID)
	if err := mw.storage.PutObject(ctx, finalKey, bytes.NewReader(all.Bytes()), "application/x-ndjson", nil); err != nil {
		return fmt.Errorf("failed to write final manifest: %w", err)
	}

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
