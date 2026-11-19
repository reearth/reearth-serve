package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

type goldenEntry struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	CRC32 string `json:"crc32"`
}

type fixtureGolden struct {
	Archive string        `json:"archive"`
	Entries []goldenEntry `json:"entries"`
}

// The in-place listing (core/archive) answers each golden list from the
// archive's central directory; this runs the extraction worker over the same
// archives so the manifest, and every key under files/, has to agree with it.
func TestExtractionMatchesSharedGoldenLists(t *testing.T) {
	goldens, err := filepath.Glob("../../scripts/fixtures/zip/data/*.golden.json")
	if err != nil || len(goldens) == 0 {
		t.Fatalf("no golden lists found: %v", err)
	}
	for _, goldenPath := range goldens {
		raw, err := os.ReadFile(goldenPath)
		if err != nil {
			t.Fatal(err)
		}
		var g fixtureGolden
		if err := json.Unmarshal(raw, &g); err != nil {
			t.Fatal(err)
		}
		t.Run(g.Archive, func(t *testing.T) {
			archive, err := os.ReadFile(filepath.Join(filepath.Dir(goldenPath), g.Archive))
			if err != nil {
				t.Fatal(err)
			}
			got := extractForGolden(t, g.Archive, archive)
			want, _ := json.MarshalIndent(g.Entries, "", " ")
			have, _ := json.MarshalIndent(got, "", " ")
			if !bytes.Equal(have, want) {
				t.Fatalf("extraction differs from the golden list\n got: %s\nwant: %s", have, want)
			}
		})
	}
}

func extractForGolden(t *testing.T, filename string, archive []byte) []goldenEntry {
	t.Helper()
	ctx := context.Background()
	storage := NewMemoryStorage()
	key := "assets/golden/" + filename
	if err := storage.PutObject(ctx, key, bytes.NewReader(archive), int64(len(archive)), "application/zip", nil); err != nil {
		t.Fatal(err)
	}
	worker := NewExtractionWorker(storage, ExtractionConfig{
		AssetID:         "golden",
		ArchiveKey:      key,
		ArchiveFilename: filename,
		ArchiveFormat:   "zip",
		MaxConcurrency:  4,
		CheckpointEvery: 100,
	})
	if err := worker.Run(ctx); err != nil {
		t.Fatalf("worker.Run: %v", err)
	}
	entries := []goldenEntry{}
	for _, fe := range readManifest(t, storage, "golden") {
		data, ok := storage.GetData("assets/golden/files/" + fe.Path)
		if !ok {
			t.Fatalf("manifest lists %q but nothing was stored there", fe.Path)
		}
		if fe.ContentEncoding == "gzip" {
			gr, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if data, err = io.ReadAll(gr); err != nil {
				t.Fatal(err)
			}
		}
		entries = append(entries, goldenEntry{Path: fe.Path, Size: fe.Size, CRC32: fmt.Sprintf("%08x", crc32.ChecksumIEEE(data))})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries
}

func TestContentTypesMatchSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/fixtures/zip/data/content-types.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Path        string `json:"path"`
		ContentType string `json:"contentType"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if got := DetectContentType(v.Path); got != v.ContentType {
			t.Errorf("DetectContentType(%q) = %q, want %q", v.Path, got, v.ContentType)
		}
	}
}

func TestShiftJISMatchesSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/fixtures/zip/data/shift-jis.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Hex  string  `json:"hex"`
		Name *string `json:"name"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		b, err := hex.DecodeString(v.Hex)
		if err != nil {
			t.Fatal(err)
		}
		got, ok := decodeShiftJIS(b)
		switch {
		case v.Name == nil && ok:
			t.Errorf("decodeShiftJIS(%s) = %q, want not Shift_JIS", v.Hex, got)
		case v.Name != nil && (!ok || got != *v.Name):
			t.Errorf("decodeShiftJIS(%s) = %q, %v, want %q", v.Hex, got, ok, *v.Name)
		}
	}
}
