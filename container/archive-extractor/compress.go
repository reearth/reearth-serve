package main

import (
	"compress/gzip"
	"io"

	compressible "github.com/reearth/compressible/go"
)

const minCompressSize = 1024 // 1KB

// ShouldCompress returns true if the file should be gzip-compressed before uploading.
func ShouldCompress(filename string, size int64) bool {
	if size < minCompressSize {
		return false
	}
	return compressible.Path(filename)
}

// GzipReader wraps a reader with gzip compression.
// The returned ReadCloser must be closed to flush the gzip writer.
func GzipReader(r io.Reader) io.ReadCloser {
	pr, pw := io.Pipe()
	gw := gzip.NewWriter(pw)

	go func() {
		_, err := io.Copy(gw, r)
		if closeErr := gw.Close(); err == nil {
			err = closeErr
		}
		pw.CloseWithError(err)
	}()

	return pr
}
