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
	Offset         int64  `json:"offset"` // offset of entry data in archive (-1 if unknown)
	Method         uint16 `json:"method"` // compression method (zip only: 0=store, 8=deflate)
}

// ArchiveExtractor provides access to entries in an archive without
// extracting the entire archive to disk.
type ArchiveExtractor interface {
	// ListEntries invokes yield once per entry in the archive, in archive
	// order. The callback is streaming — implementations must not buffer
	// the full entry set (a 500k-entry archive otherwise costs ~100MB just
	// to hold metadata). Returning a non-nil error from yield aborts
	// enumeration and propagates out.
	ListEntries(ctx context.Context, yield func(entry ArchiveEntry) error) error

	// ExtractEntry returns a reader for the given entry's uncompressed data.
	ExtractEntry(ctx context.Context, entry ArchiveEntry) (io.ReadCloser, error)
}

// RawDeflateExtractor is implemented by formats that can hand out an entry's
// compressed bytes verbatim as a raw DEFLATE stream (zip method 8), together
// with the entry's CRC-32 from the archive metadata. The worker uses this to
// transmux deflate entries into gzip objects by adding framing bytes only,
// skipping the decompress→recompress cycle entirely.
//
// ok=false means the entry is not raw-deflate-accessible (stored, exotic
// method, unknown offset) and the caller must fall back to ExtractEntry.
// ok=true with a non-nil error means the entry is eligible but the open
// failed (e.g. a dropped range GET) — retry rather than fall back.
type RawDeflateExtractor interface {
	OpenRawDeflate(ctx context.Context, entry ArchiveEntry) (rc io.ReadCloser, crc uint32, ok bool, err error)
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
