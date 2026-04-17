package main

import (
	"context"
	"errors"
	"io"
)

// ErrObjectNotFound is returned by ObjectStorage operations when a key is
// absent. Callers check this with errors.Is to distinguish "first run"
// (expected) from transient backend failures (should retry / propagate).
// Previously the checkpoint loader collapsed every GetObject error into
// "no checkpoint", which made a brief R2 blip restart extraction from
// phase A.
var ErrObjectNotFound = errors.New("object not found")

// PutOptions holds optional parameters for PutObject.
type PutOptions struct {
	ContentEncoding string
}

// ObjectStorage abstracts object storage operations (R2, in-memory mock, etc.)
// Implementations MUST wrap a not-found result so callers can detect it via
// errors.Is(err, ErrObjectNotFound). Every other error is treated as
// transient by the checkpoint path and surfaces to the container orchestrator.
type ObjectStorage interface {
	GetObject(ctx context.Context, key string) (io.ReadCloser, error)
	GetObjectRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error)
	HeadObject(ctx context.Context, key string) (int64, error)
	PutObject(ctx context.Context, key string, body io.Reader, contentLength int64, contentType string, opts *PutOptions) error
	DeleteObject(ctx context.Context, key string) error
}

// ReaderAtStorage extends ObjectStorage with io.ReaderAt support for ZIP files.
// If the storage supports this, ZipExtractor can use it for random access.
type ReaderAtStorage interface {
	ObjectStorage
	NewReaderAt(ctx context.Context, key string) (io.ReaderAt, error)
}
