package main

import (
	"compress/gzip"
	"io"
	"path/filepath"
	"strings"
)

const minCompressSize = 1024 // 1KB
// compressibleExtensions is defined in compressible_generated.go

// ShouldCompress returns true if the file should be gzip-compressed before uploading.
func ShouldCompress(filename string, size int64) bool {
	if size < minCompressSize {
		return false
	}
	ext := strings.ToLower(filepath.Ext(filename))
	return compressibleExtensions[ext]
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
