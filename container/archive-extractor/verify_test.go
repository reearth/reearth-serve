package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func verifyFixture(t *testing.T, data []byte) (*MemoryStorage, *statusServer, *httptest.Server) {
	t.Helper()
	storage := NewMemoryStorage()
	if err := storage.PutObject(context.Background(), "assets/a1/big.bin", bytes.NewReader(data), int64(len(data)), "application/octet-stream", nil); err != nil {
		t.Fatal(err)
	}
	srv := &statusServer{}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return storage, srv, ts
}

func fastVerifier(storage ObjectStorage, url string) *IntegrityVerifier {
	v := NewIntegrityVerifier(storage, VerifyConfig{JobID: "j1", AssetID: "a1", ObjectKey: "assets/a1/big.bin", WorkerAPIURL: url})
	v.retryDelay = time.Millisecond
	v.reportDelays = []time.Duration{time.Millisecond, time.Millisecond}
	v.heartbeat = 0
	return v
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestVerifyReportsTheObjectsSHA256(t *testing.T) {
	data := bytes.Repeat([]byte("integrity "), 10_000)
	storage, srv, ts := verifyFixture(t, data)

	if err := fastVerifier(storage, ts.URL).Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got := srv.statuses(); strings.Join(got, ",") != "running,completed" {
		t.Fatalf("statuses = %v, want running,completed", got)
	}
	last := srv.bodies[len(srv.bodies)-1]
	if last["sha256"] != sha256Hex(data) {
		t.Fatalf("sha256 = %v, want %s", last["sha256"], sha256Hex(data))
	}
	for _, p := range srv.paths {
		if p != "/api/internal/jobs/j1/status" {
			t.Fatalf("callback path = %s", p)
		}
	}
}

// flakyStorage cuts the first `breaks` reads short with an error after
// `cutAfter` bytes, to exercise resuming at the offset reached.
type flakyStorage struct {
	*MemoryStorage
	breaks   int
	cutAfter int64
	ranges   []int64
}

type brokenReader struct {
	r io.Reader
}

func (b *brokenReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err == io.EOF {
		return n, errors.New("unexpected EOF from store")
	}
	return n, err
}

func (f *flakyStorage) wrap(rc io.ReadCloser) io.ReadCloser {
	if f.breaks == 0 {
		return rc
	}
	f.breaks--
	return io.NopCloser(&brokenReader{r: io.LimitReader(rc, f.cutAfter)})
}

func (f *flakyStorage) GetObject(ctx context.Context, key string) (io.ReadCloser, error) {
	rc, err := f.MemoryStorage.GetObject(ctx, key)
	if err != nil {
		return nil, err
	}
	return f.wrap(rc), nil
}

func (f *flakyStorage) GetObjectRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	f.ranges = append(f.ranges, offset)
	rc, err := f.MemoryStorage.GetObjectRange(ctx, key, offset, length)
	if err != nil {
		return nil, err
	}
	return f.wrap(rc), nil
}

func TestVerifyResumesABrokenReadWhereItStopped(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789"), 1000)
	mem, srv, ts := verifyFixture(t, data)
	storage := &flakyStorage{MemoryStorage: mem, breaks: 2, cutAfter: 3000}

	if err := fastVerifier(storage, ts.URL).Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(storage.ranges) != 2 || storage.ranges[0] != 3000 || storage.ranges[1] != 6000 {
		t.Fatalf("resumed at %v, want [3000 6000]", storage.ranges)
	}
	last := srv.bodies[len(srv.bodies)-1]
	if last["status"] != "completed" || last["sha256"] != sha256Hex(data) {
		t.Fatalf("last report = %v", last)
	}
}

func TestVerifyReportsAPersistentReadErrorAsFailed(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 5000)
	mem, srv, ts := verifyFixture(t, data)
	storage := &flakyStorage{MemoryStorage: mem, breaks: 100, cutAfter: 0}
	v := fastVerifier(storage, ts.URL)
	v.readAttempts = 3

	if err := v.Run(context.Background()); err == nil {
		t.Fatal("Run succeeded, want a read error")
	}
	last := srv.bodies[len(srv.bodies)-1]
	if last["status"] != "failed" || last["sha256"] != nil {
		t.Fatalf("last report = %v, want failed without a hash", last)
	}
	if !strings.Contains(last["error"].(string), "read failed") {
		t.Fatalf("error = %v", last["error"])
	}
}

func TestVerifyDoesNotRetryAMissingObject(t *testing.T) {
	storage := NewMemoryStorage()
	srv := &statusServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	v := fastVerifier(storage, ts.URL)
	err := v.Run(context.Background())
	if !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("err = %v, want ErrObjectNotFound", err)
	}
	if got := srv.statuses(); strings.Join(got, ",") != "running,failed" {
		t.Fatalf("statuses = %v, want running,failed", got)
	}
}

func TestVerifyRetriesTheCompletionCallback(t *testing.T) {
	data := []byte("hello")
	storage, srv, ts := verifyFixture(t, data)
	srv.failures = 2 // "running" and the first "completed" attempt fail

	if err := fastVerifier(storage, ts.URL).Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := srv.statuses(); strings.Join(got, ",") != "running,completed,completed" {
		t.Fatalf("statuses = %v", got)
	}
}

func TestVerifyReportsAnUnacknowledgedHashAsNotReported(t *testing.T) {
	storage, srv, ts := verifyFixture(t, []byte("hello"))
	srv.failures = 100

	err := fastVerifier(storage, ts.URL).Run(context.Background())
	if !errors.Is(err, errVerifyNotReported) {
		t.Fatalf("err = %v, want errVerifyNotReported", err)
	}
}

func TestLoadVerifyConfigRequiresJobAndKey(t *testing.T) {
	vars := map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
		"JOB_ID":                         "j1",
	}
	if _, _, _, err := loadVerifyConfig(envFrom(vars)); err == nil || !strings.Contains(err.Error(), "OBJECT_KEY") {
		t.Fatalf("err = %v, want OBJECT_KEY required", err)
	}
	vars["OBJECT_KEY"] = "assets/a1/big.bin"
	vars["ASSET_ID"] = "a1"
	cfg, store, _, err := loadVerifyConfig(envFrom(vars))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JobID != "j1" || cfg.ObjectKey != "assets/a1/big.bin" || cfg.AssetID != "a1" || store.Bucket != "bucket" {
		t.Fatalf("cfg = %+v store = %+v", cfg, store)
	}
	// The extractor's required variables are not needed in this mode.
	if _, ok := vars["ARCHIVE_KEY"]; ok {
		t.Fatal("fixture must not set ARCHIVE_KEY")
	}
}
