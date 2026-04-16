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

// SequentialExtractor is implemented by archive formats that have no
// usable random-access primitive (e.g. tar, tar.gz). For those formats,
// per-entry ExtractEntry calls re-open and re-scan the archive each time,
// which is O(N²) — for a 10k-entry tar.gz that means 10k full gzip
// decompressions. Implementations of this interface let phaseB iterate
// the archive once and visit every entry in order.
//
// fn is called for each non-directory entry, in archive order. The reader
// is only valid for the duration of the call; consumers must read it to
// EOF (or discard it) before fn returns. Returning a non-nil error from
// fn aborts iteration and propagates the error out of ExtractAllSequential.
type SequentialExtractor interface {
	ExtractAllSequential(ctx context.Context, fn func(entry ArchiveEntry, r io.Reader) error) error
}
