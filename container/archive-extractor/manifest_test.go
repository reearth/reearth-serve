package main

import (
	"strings"
	"testing"
)

func TestDetectContentType(t *testing.T) {
	cases := map[string]string{
		// Geospatial table entries.
		"data/tiles.geojson": "application/geo+json",
		"tileset.json":       "application/json",
		"b3dm/0.b3dm":        "application/octet-stream",
		// Go built-ins, still expected to work without /etc/mime.types.
		"index.html":       "text/html",
		"assets/main.js":   "text/javascript",
		"assets/chunk.mjs": "text/javascript",
		"assets/style.css": "text/css",
		"lib/engine.wasm":  "application/wasm",
		"img/logo.svg":     "image/svg+xml",
		// Static-site extensions added on top of the built-ins.
		"robots.txt":            "text/plain",
		"assets/main.js.map":    "application/json",
		"manifest.webmanifest":  "application/manifest+json",
		"favicon.ico":           "image/x-icon",
		"fonts/Inter.woff2":     "font/woff2",
		"fonts/Inter.woff":      "font/woff",
		"fonts/Inter.ttf":       "font/ttf",
		"media/intro.mp4":       "video/mp4",
		"README.md":             "text/markdown",
		"UPPER/CASE/INDEX.HTML": "text/html",
		// Unknown stays binary.
		"blob.unknownext": "application/octet-stream",
		"noextension":     "application/octet-stream",
	}
	for name, want := range cases {
		got := DetectContentType(name)
		if !strings.HasPrefix(got, want) {
			t.Errorf("DetectContentType(%q) = %q, want prefix %q", name, got, want)
		}
	}
}
