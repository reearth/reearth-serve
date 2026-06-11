package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"fmt"
	"io"
	"log"
)

// ZipExtractor implements ArchiveExtractor for ZIP files using random access reads.
type ZipExtractor struct {
	reader  *zip.Reader
	storage ObjectStorage
	key     string
}

// NewZipExtractor creates a ZipExtractor. It reads the Central Directory
// via ReaderAt (does not download the entire file).
func NewZipExtractor(ctx context.Context, storage ObjectStorage, key string) (*ZipExtractor, error) {
	size, err := storage.HeadObject(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("failed to get archive size: %w", err)
	}

	log.Printf("zip: archive key=%s size=%d", key, size)

	var readerAt io.ReaderAt
	if ras, ok := storage.(ReaderAtStorage); ok {
		readerAt, err = ras.NewReaderAt(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("failed to create reader at: %w", err)
		}
	} else {
		// Fallback: download entire file (not ideal for large files)
		body, err := storage.GetObject(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("failed to get archive: %w", err)
		}
		defer func() { _ = body.Close() }()
		data, err := io.ReadAll(body)
		if err != nil {
			return nil, fmt.Errorf("failed to read archive: %w", err)
		}
		readerAt = newBytesReaderAt(data)
	}

	zr, err := zip.NewReader(readerAt, size)
	if err != nil {
		return nil, fmt.Errorf("failed to read zip central directory: %w", err)
	}

	log.Printf("zip: central directory has %d files", len(zr.File))
	for i, f := range zr.File {
		if i < 10 {
			log.Printf("zip: file[%d] name=%q size=%d isDir=%v", i, f.Name, f.UncompressedSize64, f.FileInfo().IsDir())
		}
	}

	return &ZipExtractor{reader: zr, storage: storage, key: key}, nil
}

// ListEntries streams entries from the ZIP Central Directory one at a time.
func (z *ZipExtractor) ListEntries(ctx context.Context, yield func(entry ArchiveEntry) error) error {
	for i, f := range z.reader.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		offset, err := f.DataOffset()
		if err != nil {
			offset = -1
		}
		if err := yield(ArchiveEntry{
			Index:          i,
			Path:           f.Name,
			Size:           int64(f.UncompressedSize64),
			CompressedSize: int64(f.CompressedSize64),
			IsDirectory:    f.FileInfo().IsDir(),
			Offset:         offset,
			Method:         f.Method,
		}); err != nil {
			return err
		}
	}
	return nil
}

// ExtractEntry returns a reader for the given entry's uncompressed content.
//
// Fast path: the Central Directory already told us where the entry's
// compressed bytes live (DataOffset + CompressedSize), so we issue ONE
// ranged GET for the whole span and decompress locally. Going through
// zip.File.Open instead would read via the io.ReaderAt, and flate consumes
// it in ~4 KiB chunks — every chunk became its own HTTPS Range request to
// R2 (a multi-MB entry cost thousands of round trips; extraction crawled
// at <1 MiB/s and a 200 GB archive would effectively never finish).
//
// Tradeoff: zip.File.Open verifies the entry CRC32; this path does not.
// Integrity is still covered end-to-end by the MD5 the caller computes for
// the manifest and R2's own checksums on upload.
func (z *ZipExtractor) ExtractEntry(ctx context.Context, entry ArchiveEntry) (io.ReadCloser, error) {
	if entry.Index < 0 || entry.Index >= len(z.reader.File) {
		return nil, fmt.Errorf("entry index %d out of range [0, %d)", entry.Index, len(z.reader.File))
	}

	if entry.Offset >= 0 && entry.CompressedSize >= 0 {
		switch entry.Method {
		case zip.Store, zip.Deflate:
			if entry.CompressedSize == 0 {
				return io.NopCloser(bytes.NewReader(nil)), nil
			}
			body, err := z.storage.GetObjectRange(ctx, z.key, entry.Offset, entry.CompressedSize)
			if err != nil {
				return nil, fmt.Errorf("failed to range-read zip entry %q: %w", entry.Path, err)
			}
			if entry.Method == zip.Store {
				return body, nil
			}
			fr := flate.NewReader(body)
			return &flateEntryReader{fr: fr, underlying: body}, nil
		}
	}

	// Slow path: unknown offset or exotic compression method — let
	// archive/zip handle it through the ReaderAt.
	f := z.reader.File[entry.Index]
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("failed to open zip entry %q: %w", entry.Path, err)
	}
	return rc, nil
}

// flateEntryReader streams a deflate-compressed zip entry and closes both
// the decompressor and the underlying HTTP body.
type flateEntryReader struct {
	fr         io.ReadCloser
	underlying io.ReadCloser
}

func (r *flateEntryReader) Read(p []byte) (int, error) {
	return r.fr.Read(p)
}

func (r *flateEntryReader) Close() error {
	err := r.fr.Close()
	if cerr := r.underlying.Close(); err == nil {
		err = cerr
	}
	return err
}

// bytesReaderAt wraps a byte slice as io.ReaderAt (fallback for non-ReaderAtStorage).
type bytesReaderAt struct {
	data []byte
}

func newBytesReaderAt(data []byte) *bytesReaderAt {
	return &bytesReaderAt{data: data}
}

func (b *bytesReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(b.data)) {
		return 0, io.EOF
	}
	n := copy(p, b.data[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
