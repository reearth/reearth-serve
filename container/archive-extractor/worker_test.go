package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

// --- helpers ---

// buildZipArchive creates a ZIP archive in memory with the given files.
func buildZipArchive(files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			panic(err)
		}
		if _, err := io.WriteString(w, content); err != nil {
			panic(err)
		}
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// buildTarArchive creates a tar archive in memory.
func buildTarArchive(files map[string]string) []byte {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, content := range files {
		hdr := &tar.Header{
			Name: name,
			Mode: 0644,
			Size: int64(len(content)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			panic(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			panic(err)
		}
	}
	if err := tw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// buildTarGzArchive creates a tar.gz archive in memory.
func buildTarGzArchive(files map[string]string) []byte {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range files {
		hdr := &tar.Header{
			Name: name,
			Mode: 0644,
			Size: int64(len(content)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			panic(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			panic(err)
		}
	}
	if err := tw.Close(); err != nil {
		panic(err)
	}
	if err := gw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// readManifest parses the final _manifest.jsonl from storage.
func readManifest(t *testing.T, storage *MemoryStorage, assetID string) []FileEntry {
	t.Helper()
	key := fmt.Sprintf("assets/%s/_archive/_manifest.jsonl", assetID)
	data, ok := storage.GetData(key)
	if !ok {
		t.Fatalf("manifest not found at %s", key)
	}
	var entries []FileEntry
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		var fe FileEntry
		if err := json.Unmarshal(scanner.Bytes(), &fe); err != nil {
			t.Fatalf("failed to unmarshal manifest entry: %v", err)
		}
		entries = append(entries, fe)
	}
	return entries
}

// --- tests ---

func TestExtractionWorker_ZipBasic(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	files := map[string]string{
		"hello.txt":        "Hello, World!",
		"subdir/data.json": `{"key":"value"}`,
		"image.png":        "fakepngdata",
	}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/test-asset/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "test-asset",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 2,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	// Verify extracted files exist in storage
	for name, content := range files {
		key := fmt.Sprintf("assets/test-asset/files/%s", name)
		data, ok := storage.GetData(key)
		if !ok {
			t.Errorf("extracted file not found: %s", key)
			continue
		}
		// For non-compressible files (image.png, hello.txt < 1KB), check raw content
		if !ShouldCompress(name, int64(len(content))) {
			if string(data) != content {
				t.Errorf("content mismatch for %s: got %q, want %q", name, string(data), content)
			}
		} else {
			// Compressed file: decompress and check
			gr, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				t.Errorf("failed to create gzip reader for %s: %v", name, err)
				continue
			}
			decompressed, err := io.ReadAll(gr)
			_ = gr.Close()
			if err != nil {
				t.Errorf("failed to decompress %s: %v", name, err)
				continue
			}
			if string(decompressed) != content {
				t.Errorf("decompressed content mismatch for %s: got %q, want %q", name, string(decompressed), content)
			}
		}
	}

	// Verify manifest
	manifest := readManifest(t, storage, "test-asset")
	if len(manifest) != len(files) {
		t.Errorf("manifest has %d entries, want %d", len(manifest), len(files))
	}

	// Verify checkpoint was cleaned up
	cpKey := "assets/test-asset/_archive/_checkpoint.json"
	if _, ok := storage.GetData(cpKey); ok {
		t.Error("checkpoint should have been deleted after completion")
	}

	// Verify entry list was cleaned up
	elKey := "assets/test-asset/_archive/_entry_list.jsonl"
	if _, ok := storage.GetData(elKey); ok {
		t.Error("entry list should have been deleted after completion")
	}
}

func TestExtractionWorker_ZipRootPrefixStripping(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// All files under "mydata/" matching the archive name "mydata.zip"
	files := map[string]string{
		"mydata/hello.txt":        "Hello!",
		"mydata/subdir/data.json": `{"a":1}`,
	}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/strip-test/upload.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "strip-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "mydata.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 100,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	// Files should be stored without the "mydata/" prefix
	expectedFiles := []string{
		"assets/strip-test/files/hello.txt",
		"assets/strip-test/files/subdir/data.json",
	}
	for _, key := range expectedFiles {
		if _, ok := storage.GetData(key); !ok {
			t.Errorf("expected file not found: %s", key)
		}
	}

	// Original prefixed paths should NOT exist
	if _, ok := storage.GetData("assets/strip-test/files/mydata/hello.txt"); ok {
		t.Error("file with root prefix should not exist")
	}
}

func TestExtractionWorker_TarGz(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	files := map[string]string{
		"a.txt":     "aaa",
		"dir/b.txt": "bbb",
	}
	archiveData := buildTarGzArchive(files)
	archiveKey := "assets/tgz-test/archive.tar.gz"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/gzip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "tgz-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.tar.gz",
		ArchiveFormat:   "tar.gz",
		MaxConcurrency:  2,
		CheckpointEvery: 10,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	for name, content := range files {
		key := fmt.Sprintf("assets/tgz-test/files/%s", name)
		data, ok := storage.GetData(key)
		if !ok {
			t.Errorf("extracted file not found: %s", key)
			continue
		}
		if string(data) != content {
			t.Errorf("content mismatch for %s: got %q, want %q", name, string(data), content)
		}
	}

	manifest := readManifest(t, storage, "tgz-test")
	if len(manifest) != len(files) {
		t.Errorf("manifest has %d entries, want %d", len(manifest), len(files))
	}
}

func TestExtractionWorker_Tar(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	files := map[string]string{
		"file1.txt": "content1",
		"file2.txt": "content2",
	}
	archiveData := buildTarArchive(files)
	archiveKey := "assets/tar-test/archive.tar"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/x-tar", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "tar-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.tar",
		ArchiveFormat:   "tar",
		MaxConcurrency:  2,
		CheckpointEvery: 10,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	for name, content := range files {
		key := fmt.Sprintf("assets/tar-test/files/%s", name)
		data, ok := storage.GetData(key)
		if !ok {
			t.Errorf("extracted file not found: %s", key)
			continue
		}
		if string(data) != content {
			t.Errorf("content mismatch for %s: got %q, want %q", name, string(data), content)
		}
	}
}

func TestExtractionWorker_ZipCompression(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// Create a large JSON file (>1KB) that should be compressed
	largeJSON := `{"data":"` + strings.Repeat("x", 2000) + `"}`
	files := map[string]string{
		"big.json":  largeJSON,
		"small.txt": "tiny",
	}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/compress-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "compress-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 100,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	// big.json should be gzip-compressed
	bigData, ok := storage.GetData("assets/compress-test/files/big.json")
	if !ok {
		t.Fatal("big.json not found")
	}
	gr, err := gzip.NewReader(bytes.NewReader(bigData))
	if err != nil {
		t.Fatalf("big.json should be gzip-compressed: %v", err)
	}
	decompressed, _ := io.ReadAll(gr)
	_ = gr.Close()
	if string(decompressed) != largeJSON {
		t.Error("big.json decompressed content mismatch")
	}

	// small.txt should NOT be compressed (< 1KB)
	smallData, ok := storage.GetData("assets/compress-test/files/small.txt")
	if !ok {
		t.Fatal("small.txt not found")
	}
	if string(smallData) != "tiny" {
		t.Errorf("small.txt content mismatch: got %q", string(smallData))
	}

	// Verify manifest content-encoding
	manifest := readManifest(t, storage, "compress-test")
	for _, fe := range manifest {
		if fe.Path == "big.json" {
			if fe.ContentEncoding != "gzip" {
				t.Error("big.json should have contentEncoding=gzip in manifest")
			}
		}
		if fe.Path == "small.txt" {
			if fe.ContentEncoding != "" {
				t.Errorf("small.txt should not have contentEncoding, got %q", fe.ContentEncoding)
			}
		}
	}
}

func TestExtractionWorker_ZipManyFiles(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// Generate 150 files to test checkpoint saving (every 50)
	files := make(map[string]string, 150)
	for i := range 150 {
		files[fmt.Sprintf("file_%03d.txt", i)] = fmt.Sprintf("content_%03d", i)
	}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/many-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "many-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  8,
		CheckpointEvery: 50,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	// Verify all files extracted
	for name, content := range files {
		key := fmt.Sprintf("assets/many-test/files/%s", name)
		data, ok := storage.GetData(key)
		if !ok {
			t.Errorf("file not found: %s", key)
			continue
		}
		if string(data) != content {
			t.Errorf("content mismatch for %s", name)
		}
	}

	manifest := readManifest(t, storage, "many-test")
	if len(manifest) != 150 {
		t.Errorf("manifest has %d entries, want 150", len(manifest))
	}
}

func TestExtractionWorker_WindowsPaths(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// ZIP entries with Windows-style backslash paths
	files := map[string]string{
		"dir\\subdir\\file.txt": "windows path content",
		"dir\\other.txt":        "other content",
	}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/winpath-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "winpath-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  2,
		CheckpointEvery: 100,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	// Paths should be normalized to forward slashes
	expected := []string{
		"assets/winpath-test/files/dir/subdir/file.txt",
		"assets/winpath-test/files/dir/other.txt",
	}
	for _, key := range expected {
		if _, ok := storage.GetData(key); !ok {
			t.Errorf("expected normalized path file not found: %s", key)
		}
	}
}

func TestExtractionWorker_EmptyArchive(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// Create empty ZIP
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	archiveKey := "assets/empty-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(buf.Bytes()), int64(buf.Len()), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "empty-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  2,
		CheckpointEvery: 100,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	manifest := readManifest(t, storage, "empty-test")
	if len(manifest) != 0 {
		t.Errorf("manifest should be empty, got %d entries", len(manifest))
	}
}

func TestExtractionWorker_ManifestContentTypes(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	files := map[string]string{
		"model.glb":    "glbdata",
		"tiles.b3dm":   "b3dmdata",
		"style.css":    "body{}",
		"data.geojson": `{"type":"FeatureCollection"}`,
	}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/ctype-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "ctype-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 100,
	})

	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	manifest := readManifest(t, storage, "ctype-test")
	ctMap := make(map[string]string)
	for _, fe := range manifest {
		ctMap[fe.Path] = fe.ContentType
	}

	expected := map[string]string{
		"model.glb":    "model/gltf-binary",
		"tiles.b3dm":   "application/octet-stream",
		"data.geojson": "application/geo+json",
	}
	for path, wantCT := range expected {
		if gotCT, ok := ctMap[path]; !ok {
			t.Errorf("manifest missing entry for %s", path)
		} else if gotCT != wantCT {
			t.Errorf("content type for %s: got %q, want %q", path, gotCT, wantCT)
		}
	}
}

func TestExtractionWorker_ZipTransmux(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// Multi-MB compressible payload so the deflate stream spans many blocks.
	content := strings.Repeat("<bldg:Building gml:id=\"BLD_0001\"/>\n", 200000)
	files := map[string]string{"city.gml": content}
	archiveData := buildZipArchive(files)
	archiveKey := "assets/transmux-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "transmux-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 100,
	})
	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	data, ok := storage.GetData("assets/transmux-test/files/city.gml")
	if !ok {
		t.Fatal("city.gml not found")
	}

	// The object must be a valid gzip member that round-trips the content.
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("output is not valid gzip: %v", err)
	}
	decompressed, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("failed to decompress: %v", err)
	}
	_ = gr.Close()
	if string(decompressed) != content {
		t.Error("decompressed content mismatch")
	}

	// Prove there was no re-encode: the gzip body must be the zip entry's
	// deflate bytes verbatim, framed by our 10-byte header and 8-byte trailer.
	zr, err := zip.NewReader(bytes.NewReader(archiveData), int64(len(archiveData)))
	if err != nil {
		t.Fatal(err)
	}
	zf := zr.File[0]
	off, err := zf.DataOffset()
	if err != nil {
		t.Fatal(err)
	}
	rawDeflate := archiveData[off : off+int64(zf.CompressedSize64)]
	if want := len(gzipMemberHeader) + len(rawDeflate) + gzipTrailerSize; len(data) != want {
		t.Fatalf("gzip object size = %d, want %d (header+raw deflate+trailer)", len(data), want)
	}
	if !bytes.Equal(data[len(gzipMemberHeader):len(data)-gzipTrailerSize], rawDeflate) {
		t.Error("gzip body is not the zip entry's deflate stream — entry was re-encoded")
	}

	// Manifest hash must be the MD5 of the *uncompressed* content.
	manifest := readManifest(t, storage, "transmux-test")
	if len(manifest) != 1 {
		t.Fatalf("manifest has %d entries, want 1", len(manifest))
	}
	wantHash := fmt.Sprintf("md5:%x", md5.Sum([]byte(content)))
	if manifest[0].Hash != wantHash {
		t.Errorf("manifest hash = %q, want %q", manifest[0].Hash, wantHash)
	}
	if manifest[0].ContentEncoding != "gzip" {
		t.Errorf("manifest contentEncoding = %q, want gzip", manifest[0].ContentEncoding)
	}
}

func TestExtractionWorker_ZipTransmuxStoredFallback(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	// A compressible-by-extension entry stored with method Store cannot be
	// transmuxed and must fall back to the decompress→gzip path.
	content := strings.Repeat("stored but compressible\n", 1000)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: "stored.txt", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(w, content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	archiveData := buf.Bytes()
	archiveKey := "assets/stored-test/archive.zip"
	if err := storage.PutObject(ctx, archiveKey, bytes.NewReader(archiveData), int64(len(archiveData)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "stored-test",
		ArchiveKey:      archiveKey,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 100,
	})
	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run failed: %v", err)
	}

	data, ok := storage.GetData("assets/stored-test/files/stored.txt")
	if !ok {
		t.Fatal("stored.txt not found")
	}
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("stored.txt should be gzip-compressed via fallback: %v", err)
	}
	decompressed, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("failed to decompress: %v", err)
	}
	_ = gr.Close()
	if string(decompressed) != content {
		t.Error("decompressed content mismatch")
	}
}
