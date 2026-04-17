package main

import (
	"path/filepath"
	"strings"
)

// NormalizeSeparators converts backslashes to forward slashes
// and cleans the path.
func NormalizeSeparators(rawPath string) string {
	p := strings.ReplaceAll(rawPath, "\\", "/")
	// Remove leading slash
	p = strings.TrimPrefix(p, "/")
	// Clean double slashes, dot segments, etc.
	p = filepath.ToSlash(filepath.Clean(p))
	return p
}

// RootPrefixDetector computes the common root folder incrementally. Feeding
// each entry path in with Observe keeps memory flat (O(1)) compared to
// buffering the entire entry list just to decide whether to strip a prefix.
// Call Result once after all paths are observed.
type RootPrefixDetector struct {
	commonRoot string
	conflict   bool
	seen       bool
}

// Observe records the first path segment of the given raw entry path.
func (d *RootPrefixDetector) Observe(rawPath string) {
	if d.conflict {
		return
	}
	p := NormalizeSeparators(rawPath)
	if p == "" {
		return
	}
	seg := firstSegment(p)
	if !d.seen {
		d.commonRoot = seg
		d.seen = true
		return
	}
	if seg != d.commonRoot {
		d.conflict = true
		d.commonRoot = ""
	}
}

// Result returns the prefix to strip (e.g. "data/") if the observed entries
// all shared a single root that matches the archive filename, or empty.
func (d *RootPrefixDetector) Result(archiveFilename string) string {
	if d.conflict || d.commonRoot == "" {
		return ""
	}

	baseName := archiveFilename
	for _, ext := range []string{".tar.gz", ".tar.bz2", ".tgz", ".zip", ".tar"} {
		if strings.HasSuffix(strings.ToLower(baseName), ext) {
			baseName = baseName[:len(baseName)-len(ext)]
			break
		}
	}

	if d.commonRoot == baseName || d.commonRoot == archiveFilename {
		return d.commonRoot + "/"
	}
	return ""
}

// DetectRootPrefix determines if all entries share a single root folder
// that matches the archive filename (with or without extension).
// Returns the prefix to strip (e.g. "data/"), or empty string if no stripping needed.
func DetectRootPrefix(entries []ArchiveEntry, archiveFilename string) string {
	d := RootPrefixDetector{}
	for _, e := range entries {
		d.Observe(e.Path)
	}
	return d.Result(archiveFilename)
}

// StripPrefix removes the root prefix from a normalized path.
func StripPrefix(normalizedPath, prefix string) string {
	if prefix == "" {
		return normalizedPath
	}
	return strings.TrimPrefix(normalizedPath, prefix)
}

// firstSegment returns the first path segment (before the first slash).
func firstSegment(p string) string {
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return p
}
