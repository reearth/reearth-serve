package main

import (
	"archive/zip"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type fixtureGolden struct {
	Archive         string `json:"archive"`
	ExtractorParity bool   `json:"extractorParity"`
	Entries         []struct {
		Path string `json:"path"`
	} `json:"entries"`
}

// The in-place reader in core/archive and this extractor must name every
// entry identically, or links into an archive change when extraction ends.
func TestExtractedPathsMatchSharedGoldenLists(t *testing.T) {
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
		if !g.ExtractorParity {
			continue
		}
		t.Run(g.Archive, func(t *testing.T) {
			zr, err := zip.OpenReader(filepath.Join(filepath.Dir(goldenPath), g.Archive))
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = zr.Close() }()

			detector := &RootPrefixDetector{}
			for _, f := range zr.File {
				detector.Observe(f.Name)
			}
			prefix := detector.Result(g.Archive)

			var got []string
			for _, f := range zr.File {
				if f.FileInfo().IsDir() {
					continue
				}
				got = append(got, StripPrefix(NormalizeSeparators(f.Name), prefix))
			}
			sort.Strings(got)
			want := make([]string, len(g.Entries))
			for i, e := range g.Entries {
				want[i] = e.Path
			}
			if strings.Join(got, "\n") != strings.Join(want, "\n") {
				t.Fatalf("extracted paths differ from the golden list\n got: %q\nwant: %q", got, want)
			}
		})
	}
}
