package main

import "testing"

func TestNormalizeSeparators(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"tiles/0/0/0.pbf", "tiles/0/0/0.pbf"},
		{"tiles\\12\\345\\678.pbf", "tiles/12/345/678.pbf"},
		{"/leading/slash.txt", "leading/slash.txt"},
		{"double//slash.txt", "double/slash.txt"},
		{"mixed\\path/file.txt", "mixed/path/file.txt"},
		{"./relative/path.txt", "relative/path.txt"},
		{"", "."},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := NormalizeSeparators(tt.input)
			if got != tt.want {
				t.Errorf("NormalizeSeparators(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestDetectRootPrefix(t *testing.T) {
	tests := []struct {
		name            string
		entries         []ArchiveEntry
		archiveFilename string
		want            string
	}{
		{
			name: "single root matching archive name without extension",
			entries: []ArchiveEntry{
				{Path: "data/tileset.json"},
				{Path: "data/tiles/0/0/0.pbf"},
				{Path: "data/tiles/1/0/0.pbf"},
			},
			archiveFilename: "data.zip",
			want:            "data/",
		},
		{
			name: "single root matching archive name with extension",
			entries: []ArchiveEntry{
				{Path: "data.zip/tileset.json"},
				{Path: "data.zip/tiles/0/0/0.pbf"},
			},
			archiveFilename: "data.zip",
			want:            "data.zip/",
		},
		{
			name: "single root not matching archive name",
			entries: []ArchiveEntry{
				{Path: "other/tileset.json"},
				{Path: "other/tiles/0/0/0.pbf"},
			},
			archiveFilename: "data.zip",
			want:            "",
		},
		{
			name: "multiple roots",
			entries: []ArchiveEntry{
				{Path: "tileset.json"},
				{Path: "tiles/0/0/0.pbf"},
			},
			archiveFilename: "data.zip",
			want:            "",
		},
		{
			name:            "empty entries",
			entries:         []ArchiveEntry{},
			archiveFilename: "data.zip",
			want:            "",
		},
		{
			name: "tar.gz extension",
			entries: []ArchiveEntry{
				{Path: "mydata/file1.txt"},
				{Path: "mydata/file2.txt"},
			},
			archiveFilename: "mydata.tar.gz",
			want:            "mydata/",
		},
		{
			name: "backslash paths with matching root",
			entries: []ArchiveEntry{
				{Path: "data\\tileset.json"},
				{Path: "data\\tiles\\0\\0\\0.pbf"},
			},
			archiveFilename: "data.zip",
			want:            "data/",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DetectRootPrefix(tt.entries, tt.archiveFilename)
			if got != tt.want {
				t.Errorf("DetectRootPrefix() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestStripPrefix(t *testing.T) {
	tests := []struct {
		path   string
		prefix string
		want   string
	}{
		{"data/tileset.json", "data/", "tileset.json"},
		{"data/tiles/0/0/0.pbf", "data/", "tiles/0/0/0.pbf"},
		{"tileset.json", "", "tileset.json"},
		{"other/file.txt", "data/", "other/file.txt"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := StripPrefix(tt.path, tt.prefix)
			if got != tt.want {
				t.Errorf("StripPrefix(%q, %q) = %q, want %q", tt.path, tt.prefix, got, tt.want)
			}
		})
	}
}
