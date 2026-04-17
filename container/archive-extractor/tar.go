package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"strings"
)

// TarExtractor implements ArchiveExtractor for tar and tar.gz files.
type TarExtractor struct {
	storage   ObjectStorage
	key       string
	isGzipped bool
}

// NewTarExtractor creates a TarExtractor.
// Set isGzipped to true for .tar.gz / .tgz files.
func NewTarExtractor(storage ObjectStorage, key string, isGzipped bool) *TarExtractor {
	return &TarExtractor{storage: storage, key: key, isGzipped: isGzipped}
}

// ListEntries streams tar headers through the callback one at a time.
func (t *TarExtractor) ListEntries(ctx context.Context, yield func(entry ArchiveEntry) error) error {
	tr, cleanup, err := t.openTarReader(ctx)
	if err != nil {
		return err
	}
	defer cleanup()

	var offset int64
	index := 0

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header at index %d: %w", index, err)
		}

		if err := yield(ArchiveEntry{
			Index:          index,
			Path:           hdr.Name,
			Size:           hdr.Size,
			CompressedSize: hdr.Size,
			IsDirectory:    hdr.Typeflag == tar.TypeDir,
			Offset:         offset,
		}); err != nil {
			return err
		}

		offset += hdr.Size
		index++
	}
}

// ExtractEntry opens the tar archive, seeks to the given entry, and returns
// a reader for its content.
//
// NOTE: This is O(N) per call (full re-scan of the archive). Prefer
// ExtractAllSequential for batch extraction; this method exists to satisfy
// the ArchiveExtractor interface and as a fallback for single-entry needs.
func (t *TarExtractor) ExtractEntry(ctx context.Context, entry ArchiveEntry) (io.ReadCloser, error) {
	tr, cleanup, err := t.openTarReader(ctx)
	if err != nil {
		return nil, err
	}

	for i := 0; i <= entry.Index; i++ {
		hdr, err := tr.Next()
		if err == io.EOF {
			cleanup()
			return nil, fmt.Errorf("entry index %d not found (EOF at %d)", entry.Index, i)
		}
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("failed to read tar header at index %d: %w", i, err)
		}

		if i == entry.Index {
			if hdr.Typeflag == tar.TypeDir {
				cleanup()
				return nil, fmt.Errorf("entry %q is a directory", entry.Path)
			}
			return &tarEntryReader{Reader: io.LimitReader(tr, hdr.Size), cleanup: cleanup}, nil
		}
	}

	cleanup()
	return nil, fmt.Errorf("entry index %d not found", entry.Index)
}

// ExtractAllSequential opens the tar archive once and invokes fn for every
// non-directory entry in archive order. This avoids the O(N²) re-scan that
// per-entry ExtractEntry would incur for tar/tar.gz.
func (t *TarExtractor) ExtractAllSequential(ctx context.Context, fn func(entry ArchiveEntry, r io.Reader) error) error {
	tr, cleanup, err := t.openTarReader(ctx)
	if err != nil {
		return err
	}
	defer cleanup()

	index := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header at index %d: %w", index, err)
		}

		entry := ArchiveEntry{
			Index:          index,
			Path:           hdr.Name,
			NormalizedPath: hdr.Name,
			Size:           hdr.Size,
			CompressedSize: hdr.Size,
			IsDirectory:    hdr.Typeflag == tar.TypeDir,
		}
		index++

		if entry.IsDirectory {
			continue
		}

		// io.LimitReader keeps fn from over-reading into the next header.
		if err := fn(entry, io.LimitReader(tr, hdr.Size)); err != nil {
			return err
		}
	}
}

func (t *TarExtractor) openTarReader(ctx context.Context) (*tar.Reader, func(), error) {
	body, err := t.storage.GetObject(ctx, t.key)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get tar archive: %w", err)
	}

	var reader io.Reader = body
	var closers []io.Closer
	closers = append(closers, body)

	if t.isGzipped {
		gz, err := gzip.NewReader(body)
		if err != nil {
			_ = body.Close()
			return nil, nil, fmt.Errorf("failed to create gzip reader: %w", err)
		}
		reader = gz
		closers = append(closers, gz)
	}

	tr := tar.NewReader(reader)
	cleanup := func() {
		for i := len(closers) - 1; i >= 0; i-- {
			_ = closers[i].Close()
		}
	}

	return tr, cleanup, nil
}

type tarEntryReader struct {
	io.Reader
	cleanup func()
	closed  bool
}

func (r *tarEntryReader) Close() error {
	if !r.closed {
		r.closed = true
		r.cleanup()
	}
	return nil
}

// DetectArchiveFormat returns the archive format based on filename extension.
func DetectArchiveFormat(filename string) string {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz"):
		return "tar.gz"
	case strings.HasSuffix(lower, ".tar.bz2"):
		return "tar.bz2"
	case strings.HasSuffix(lower, ".tar"):
		return "tar"
	case strings.HasSuffix(lower, ".zip"):
		return "zip"
	default:
		return ""
	}
}

// IsArchive returns true if the filename has a recognized archive extension.
func IsArchive(filename string) bool {
	return DetectArchiveFormat(filename) != ""
}
