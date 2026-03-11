package main

import (
	"context"
	"io"
)

// PutOptions holds optional parameters for PutObject.
type PutOptions struct {
	ContentEncoding string
}

// ObjectStorage abstracts object storage operations (R2, in-memory mock, etc.)
type ObjectStorage interface {
	GetObject(ctx context.Context, key string) (io.ReadCloser, error)
	GetObjectRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error)
	HeadObject(ctx context.Context, key string) (int64, error)
	PutObject(ctx context.Context, key string, body io.Reader, contentType string, opts *PutOptions) error
	DeleteObject(ctx context.Context, key string) error
}

// ReaderAtStorage extends ObjectStorage with io.ReaderAt support for ZIP files.
// If the storage supports this, ZipExtractor can use it for random access.
type ReaderAtStorage interface {
	ObjectStorage
	NewReaderAt(ctx context.Context, key string) (io.ReaderAt, error)
}
