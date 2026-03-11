package main

import (
	"context"
	"io"
)

// ArchiveEntry represents a single entry in an archive.
type ArchiveEntry struct {
	Index          int    `json:"index"`
	Path           string `json:"path"`           // raw path from archive
	NormalizedPath string `json:"normalizedPath"` // after path normalization
	Size           int64  `json:"size"`           // uncompressed size (-1 if unknown)
	CompressedSize int64  `json:"compressedSize"` // size in archive (-1 if unknown)
	IsDirectory    bool   `json:"isDirectory"`
	Offset         int64  `json:"offset"` // offset in archive (for resume)
}

// ArchiveExtractor provides access to entries in an archive without
// extracting the entire archive to disk.
type ArchiveExtractor interface {
	// ListEntries returns all entries in the archive.
	ListEntries(ctx context.Context) ([]ArchiveEntry, error)

	// ExtractEntry returns a reader for the given entry's uncompressed data.
	ExtractEntry(ctx context.Context, entry ArchiveEntry) (io.ReadCloser, error)
}
