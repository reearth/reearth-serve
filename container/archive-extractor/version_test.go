package main

import (
	"bytes"
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoadConfigAddressesTheRunByJobAndVersion(t *testing.T) {
	vars := requiredExtractionVars()
	vars["OBJECT_STORE_ENDPOINT"] = "https://example.com"
	vars["OBJECT_STORE_ACCESS_KEY_ID"] = "key"
	vars["OBJECT_STORE_SECRET_ACCESS_KEY"] = "secret"
	vars["OBJECT_STORE_BUCKET"] = "bucket"
	vars["JOB_ID"] = "job-1"
	vars["VERSION_ID"] = "ver-1"
	cfg, err := loadConfig(envFrom(vars))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JobID != "job-1" || cfg.VersionID != "ver-1" {
		t.Fatalf("JobID=%q VersionID=%q, want job-1 ver-1", cfg.JobID, cfg.VersionID)
	}
}

// A version's job must extract under the version's prefix and report to its
// own job, leaving the asset's root files and job alone (ADR-005).
func TestVersionJobStaysUnderVersionPrefix(t *testing.T) {
	srv := &statusServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx := context.Background()
	storage := NewMemoryStorage()
	root := []byte("root")
	if err := storage.PutObject(ctx, "assets/a1/files/a.txt", bytes.NewReader(root), int64(len(root)), "text/plain", nil); err != nil {
		t.Fatal(err)
	}
	data := buildZipArchive(map[string]string{"a.txt": "version"})
	key := "assets/a1/v/v1/archive.zip"
	if err := storage.PutObject(ctx, key, bytes.NewReader(data), int64(len(data)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}

	w := NewExtractionWorker(storage, ExtractionConfig{
		JobID:           "j1",
		AssetID:         "a1",
		VersionID:       "v1",
		ArchiveKey:      key,
		ArchiveFilename: "archive.zip",
		ArchiveFormat:   "zip",
		WorkerAPIURL:    ts.URL,
	})
	if err := w.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if _, ok := storage.GetData("assets/a1/v/v1/files/a.txt"); !ok {
		t.Error("version file not written under assets/a1/v/v1/files/")
	}
	if _, ok := storage.GetData("assets/a1/v/v1/_archive/_manifest.jsonl"); !ok {
		t.Error("manifest not written under assets/a1/v/v1/_archive/")
	}
	if got, _ := storage.GetData("assets/a1/files/a.txt"); string(got) != "root" {
		t.Errorf("asset root file = %q, want it untouched", got)
	}
	for _, k := range storage.Keys() {
		if strings.HasPrefix(k, "assets/a1/_archive/") {
			t.Errorf("run state leaked into the asset root: %s", k)
		}
	}

	srv.mu.Lock()
	defer srv.mu.Unlock()
	if len(srv.paths) == 0 {
		t.Fatal("no status callbacks")
	}
	for _, p := range srv.paths {
		if p != "/api/internal/jobs/j1/status" {
			t.Errorf("status posted to %s, want /api/internal/jobs/j1/status", p)
		}
	}
}
