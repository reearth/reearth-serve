package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// statusServer records every job status callback and fails the first
// `failures` of them with a 500.
type statusServer struct {
	mu       sync.Mutex
	failures int
	bodies   []map[string]any
}

func (s *statusServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !strings.HasSuffix(r.URL.Path, "/status") {
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.bodies = append(s.bodies, body)
	if s.failures > 0 {
		s.failures--
		w.WriteHeader(http.StatusInternalServerError)
	}
}

func (s *statusServer) statuses() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, b := range s.bodies {
		out = append(out, b["status"].(string))
	}
	return out
}

func fastStatusRetries(t *testing.T) {
	t.Helper()
	saved := statusRetryDelays
	statusRetryDelays = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() { statusRetryDelays = saved })
}

func newZipWorker(t *testing.T, storage *MemoryStorage, assetID, apiURL string) *ExtractionWorker {
	t.Helper()
	data := buildZipArchive(map[string]string{"a.txt": "hello"})
	key := "assets/" + assetID + "/archive.zip"
	if err := storage.PutObject(context.Background(), key, bytes.NewReader(data), int64(len(data)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}
	return NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         assetID,
		ArchiveKey:      key,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		WorkerAPIURL:    apiURL,
	})
}

func TestCompletedCallbackIsRetried(t *testing.T) {
	fastStatusRetries(t)
	srv := &statusServer{failures: 1}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	storage := NewMemoryStorage()
	if err := newZipWorker(t, storage, "retry-ok", ts.URL).Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	st := srv.statuses()
	if got := st[len(st)-1]; got != "completed" {
		t.Fatalf("last status = %q, want completed (all: %v)", got, st)
	}
}

func TestUnacknowledgedCompletionKeepsCheckpoint(t *testing.T) {
	fastStatusRetries(t)
	srv := &statusServer{failures: 1000}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	storage := NewMemoryStorage()
	err := newZipWorker(t, storage, "retry-fail", ts.URL).Run(context.Background())
	if !errors.Is(err, errCompletionNotReported) {
		t.Fatalf("Run error = %v, want errCompletionNotReported", err)
	}
	if _, ok := storage.GetData("assets/retry-fail/_archive/_checkpoint.json"); !ok {
		t.Fatal("checkpoint deleted although completion was never acknowledged")
	}

	// The re-enqueued run resumes at phase C and only has to report.
	srv.mu.Lock()
	srv.failures = 0
	srv.mu.Unlock()
	if err := newZipWorker(t, storage, "retry-fail", ts.URL).Run(context.Background()); err != nil {
		t.Fatalf("resumed Run: %v", err)
	}
	if _, ok := storage.GetData("assets/retry-fail/_archive/_checkpoint.json"); ok {
		t.Fatal("checkpoint kept after acknowledged completion")
	}
}

func TestFailedStatusDoesNotZeroProgress(t *testing.T) {
	srv := &statusServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	w := NewExtractionWorker(NewMemoryStorage(), ExtractionConfig{AssetID: "x", WorkerAPIURL: ts.URL})
	if err := w.updateJobStatus(context.Background(), "failed", 0, 0, withError("boom")); err != nil {
		t.Fatal(err)
	}
	body := srv.bodies[0]
	if _, ok := body["fileCount"]; ok {
		t.Errorf("payload carries fileCount: %v", body)
	}
	if _, ok := body["extractedSize"]; ok {
		t.Errorf("payload carries extractedSize: %v", body)
	}
}

func TestTransmuxCRCMismatchLeavesNoObject(t *testing.T) {
	storage := NewMemoryStorage()
	ctx := context.Background()

	data := buildZipArchive(map[string]string{"city.gml": strings.Repeat("<bldg/>\n", 10000)})
	// Corrupt the CRC-32 in the central directory record (offset 16).
	cd := bytes.Index(data, []byte{0x50, 0x4b, 0x01, 0x02})
	crc := binary.LittleEndian.Uint32(data[cd+16:])
	binary.LittleEndian.PutUint32(data[cd+16:], crc^0xffffffff)

	key := "assets/crc/archive.zip"
	if err := storage.PutObject(ctx, key, bytes.NewReader(data), int64(len(data)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}
	w := NewExtractionWorker(storage, ExtractionConfig{
		AssetID: "crc", ArchiveKey: key, ArchiveFilename: "archive.zip", ArchiveFormat: "zip",
	})
	if err := w.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, ok := storage.GetData("assets/crc/files/city.gml"); ok {
		t.Fatal("object that failed CRC verification is still stored")
	}
}

func TestStallTimeoutConnFiresWithoutProgress(t *testing.T) {
	client, server := net.Pipe()
	defer func() { _ = server.Close() }()
	conn := &stallTimeoutConn{Conn: client, timeout: 50 * time.Millisecond}

	start := time.Now()
	_, err := conn.Read(make([]byte, 1))
	var ne net.Error
	if !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("Read error = %v, want timeout", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("stall timeout took too long")
	}

	// A peer that keeps sending keeps the connection alive past the timeout.
	conn2Client, conn2Server := net.Pipe()
	defer func() { _ = conn2Server.Close() }()
	conn2 := &stallTimeoutConn{Conn: conn2Client, timeout: 50 * time.Millisecond}
	go func() {
		for range 5 {
			time.Sleep(30 * time.Millisecond)
			_, _ = conn2Server.Write([]byte("x"))
		}
		_ = conn2Server.Close()
	}()
	n, err := io.Copy(io.Discard, conn2)
	if err != nil || n != 5 {
		t.Fatalf("slow-but-steady read: n=%d err=%v", n, err)
	}
}

// failingCheckpointStorage fails checkpoint writes for one phase, once.
type failingCheckpointStorage struct {
	*MemoryStorage
	failPhase string
}

func (s *failingCheckpointStorage) PutObject(ctx context.Context, key string, body io.Reader, size int64, contentType string, opts *PutOptions) error {
	if s.failPhase != "" && strings.HasSuffix(key, "/_checkpoint.json") {
		data, _ := io.ReadAll(body)
		if bytes.Contains(data, []byte(`"phase":"`+s.failPhase+`"`)) {
			s.failPhase = ""
			return errors.New("injected checkpoint write failure")
		}
		body = bytes.NewReader(data)
	}
	return s.MemoryStorage.PutObject(ctx, key, body, size, contentType, opts)
}

func TestFailedReportingCheckpointCanRerunFinalize(t *testing.T) {
	mem := NewMemoryStorage()
	storage := &failingCheckpointStorage{MemoryStorage: mem, failPhase: "reporting"}
	data := buildZipArchive(map[string]string{"a.txt": "hello"})
	key := "assets/ckpt/archive.zip"
	if err := mem.PutObject(context.Background(), key, bytes.NewReader(data), int64(len(data)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}
	cfg := ExtractionConfig{AssetID: "ckpt", ArchiveKey: key, ArchiveFilename: "archive.zip", ArchiveFormat: "zip"}

	if err := NewExtractionWorker(storage, cfg).Run(context.Background()); err == nil {
		t.Fatal("expected the injected checkpoint failure")
	}
	if err := NewExtractionWorker(storage, cfg).Run(context.Background()); err != nil {
		t.Fatalf("rerun after a failed reporting checkpoint: %v", err)
	}
	if len(readManifest(t, mem, "ckpt")) != 1 {
		t.Fatal("manifest missing the extracted entry")
	}
}
