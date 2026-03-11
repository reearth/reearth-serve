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

// DetectRootPrefix determines if all entries share a single root folder
// that matches the archive filename (with or without extension).
// Returns the prefix to strip (e.g. "data/"), or empty string if no stripping needed.
func DetectRootPrefix(entries []ArchiveEntry, archiveFilename string) string {
	if len(entries) == 0 {
		return ""
	}

	// Collect the first path segment of every entry
	var commonRoot string
	for _, e := range entries {
		p := NormalizeSeparators(e.Path)
		if p == "" {
			continue
		}

		seg := firstSegment(p)
		if commonRoot == "" {
			commonRoot = seg
		} else if seg != commonRoot {
			// Multiple different root segments → no stripping
			return ""
		}
	}

	if commonRoot == "" {
		return ""
	}

	// Check if the common root matches the archive name (with or without extension)
	baseName := archiveFilename
	// Strip known archive extensions progressively: .tar.gz, .tar.bz2, .zip, .tar
	for _, ext := range []string{".tar.gz", ".tar.bz2", ".tgz", ".zip", ".tar"} {
		if strings.HasSuffix(strings.ToLower(baseName), ext) {
			baseName = baseName[:len(baseName)-len(ext)]
			break
		}
	}

	if commonRoot == baseName || commonRoot == archiveFilename {
		return commonRoot + "/"
	}

	return ""
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
