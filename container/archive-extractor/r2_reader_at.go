package main

import (
	"context"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// R2ReaderAt implements io.ReaderAt over R2 using HTTP Range requests.
// This allows archive/zip.NewReader to read ZIP files directly from R2
// without downloading the entire file.
type R2ReaderAt struct {
	client *s3.Client
	bucket string
	key    string
	ctx    context.Context
}

// ReadAt implements io.ReaderAt by issuing a Range GET to R2.
func (r *R2ReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}

	rangeHeader := fmt.Sprintf("bytes=%d-%d", off, off+int64(len(p))-1)
	out, err := r.client.GetObject(r.ctx, &s3.GetObjectInput{
		Bucket: &r.bucket,
		Key:    &r.key,
		Range:  &rangeHeader,
	})
	if err != nil {
		return 0, fmt.Errorf("R2ReaderAt.ReadAt offset=%d len=%d: %w", off, len(p), err)
	}
	defer func() { _ = out.Body.Close() }()

	return io.ReadFull(out.Body, p)
}
