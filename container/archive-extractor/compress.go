package main

import (
	"encoding/binary"
	"io"

	"github.com/klauspost/compress/gzip"
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
//
// BestSpeed because this runs on the extraction critical path: the encoder is
// the dominant CPU cost per byte, and on PLATEAU-style XML the size penalty
// vs the default level is a few percent while the encode is several times
// faster. Entries coming out of a deflate zip don't even reach this path —
// they are transmuxed (see gzipMemberHeader) without re-encoding.
func GzipReader(r io.Reader) io.ReadCloser {
	pr, pw := io.Pipe()
	gw, _ := gzip.NewWriterLevel(pw, gzip.BestSpeed)

	go func() {
		_, err := io.Copy(gw, r)
		if closeErr := gw.Close(); err == nil {
			err = closeErr
		}
		pw.CloseWithError(err)
	}()

	return pr
}

// gzipMemberHeader is a minimal RFC 1952 member header: magic bytes, deflate
// compression (CM=8), no flags, zero mtime, no extra flags, unknown OS.
//
// A gzip member is exactly this header + a raw DEFLATE stream + an 8-byte
// trailer. A zip entry stored with method 8 holds the same raw DEFLATE
// stream, and the zip central directory carries the CRC-32 and uncompressed
// size the trailer needs — so a deflate zip entry can be re-wrapped as a
// valid gzip object by concatenating bytes, with no decompression involved.
var gzipMemberHeader = []byte{0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff}

const gzipTrailerSize = 8

// gzipTrailer builds the RFC 1952 member trailer: CRC-32 (IEEE) of the
// uncompressed data followed by ISIZE (uncompressed length mod 2^32), both
// little-endian.
func gzipTrailer(crc uint32, uncompressedSize int64) []byte {
	t := make([]byte, gzipTrailerSize)
	binary.LittleEndian.PutUint32(t[0:4], crc)
	binary.LittleEndian.PutUint32(t[4:8], uint32(uncompressedSize))
	return t
}
