// Command generate writes the zip fixtures for core/archive and the archive
// extractor, each beside a golden list of the entries Serve must report.
//
//	go run . -out data            small fixtures, committed
//	go run . -out large -large    Zip64 and many-entry fixtures, generated on demand
package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"hash/crc32"
	"log"
	"os"
	"path/filepath"
	"sort"
)

type entry struct {
	raw        string
	want       string
	data       []byte
	store      bool
	descriptor bool
	nonUTF8    bool
	extra      []byte
}

type fixture struct {
	filename string
	prefix   []byte
	entries  []entry
}

type goldenEntry struct {
	Path  string `json:"path"`
	Size  int    `json:"size"`
	CRC32 string `json:"crc32"`
}

type golden struct {
	Archive string        `json:"archive"`
	Entries []goldenEntry `json:"entries"`
}

func file(name string, data string) entry {
	return entry{raw: name, want: name, data: []byte(data)}
}

func dir(name string) entry {
	return entry{raw: name}
}

func legacy(hexName, want, data string) entry {
	raw, err := hex.DecodeString(hexName)
	if err != nil {
		log.Fatal(err)
	}
	return entry{raw: string(raw), want: want, data: []byte(data), nonUTF8: true}
}

func unicodePathExtra(utf8Name string, crcOf string) []byte {
	var b bytes.Buffer
	body := make([]byte, 5)
	body[0] = 1
	binary.LittleEndian.PutUint32(body[1:], crc32.ChecksumIEEE([]byte(crcOf)))
	body = append(body, utf8Name...)
	_ = binary.Write(&b, binary.LittleEndian, uint16(0x7075))
	_ = binary.Write(&b, binary.LittleEndian, uint16(len(body)))
	b.Write(body)
	return b.Bytes()
}

func smallFixtures() []fixture {
	text := bytes.Repeat([]byte("PLATEAU building footprint 13101 "), 200)
	grusseRaw := string([]byte("Gr\x81\xe1e.txt"))
	return []fixture{
		{filename: "deflate.zip", entries: []entry{
			{raw: "a.txt", want: "a.txt", data: text},
			{raw: "dir/b.geojson", want: "dir/b.geojson", data: []byte(`{"type":"FeatureCollection","features":[]}`)},
			{raw: "dir/sub/c.bin", want: "dir/sub/c.bin", data: bytes.Repeat([]byte{0, 1, 2, 3}, 1024)},
			{raw: "empty.txt", want: "empty.txt", data: nil},
		}},
		{filename: "store.zip", entries: []entry{
			{raw: "index.html", want: "index.html", data: []byte("<!doctype html><title>x</title>"), store: true},
			{raw: "img/tile.png", want: "img/tile.png", data: []byte("\x89PNG\r\n\x1a\n"), store: true},
		}},
		{filename: "descriptor.zip", entries: []entry{
			{raw: "a/1.txt", want: "a/1.txt", data: text, descriptor: true},
			{raw: "a/2.txt", want: "a/2.txt", data: []byte("two"), descriptor: true, store: true},
			{raw: "b.txt", want: "b.txt", data: []byte("plain")},
		}},
		{filename: "cp437.zip", entries: []entry{
			legacy("636166822e747874", "café.txt", "cafe"),
			legacy("9a6e8b636f64652f6e618b76652e747874", "Ünïcode/naïve.txt", "naive"),
			file("ascii.txt", "ascii"),
		}},
		{filename: "shift_jis.zip", entries: []entry{
			legacy("93fa967b8cea2f8366815b835e2e747874", "日本語/データ.txt", "data"),
			legacy("93fa967b8cea2f926e907d2f938c8b9e2e67656f6a736f6e", "日本語/地図/東京.geojson", "{}"),
			legacy("8e9197bf2e637376", "資料.csv", "a,b\n1,2\n"),
			file("readme.txt", "ascii stays ascii"),
		}},
		{filename: "unicode-extra.zip", entries: []entry{
			{raw: grusseRaw, want: "Grüße.txt", data: []byte("hello"), nonUTF8: true, extra: unicodePathExtra("Grüße.txt", grusseRaw)},
			{raw: string([]byte("caf\x82.txt")), want: "café.txt", data: []byte("stale extra"), nonUTF8: true, extra: unicodePathExtra("wrong.txt", "not the raw name")},
		}},
		{filename: "duplicates.zip", entries: []entry{
			{raw: "dup.txt", want: "", data: []byte("first")},
			file("other.txt", "other"),
			{raw: "dup.txt", want: "dup.txt", data: []byte("second, the one that wins")},
		}},
		{filename: "escape.zip", entries: []entry{
			{raw: "../evil.txt", data: []byte("x")},
			{raw: "a/../../evil2.txt", data: []byte("x")},
			{raw: "a/../ok.txt", want: "ok.txt", data: []byte("ok")},
			{raw: "/abs.txt", want: "abs.txt", data: []byte("abs")},
			{raw: "win\\path.txt", want: "win/path.txt", data: []byte("win")},
			{raw: "./dot.txt", want: "dot.txt", data: []byte("dot")},
		}},
		{filename: "site.zip", entries: []entry{
			dir("site/"),
			{raw: "site/index.html", want: "index.html", data: []byte("<!doctype html>")},
			dir("site/assets/"),
			{raw: "site/assets/app.js", want: "assets/app.js", data: []byte("console.log(1)")},
		}},
		{filename: "root-mismatch.zip", entries: []entry{
			{raw: "site/index.html", want: "site/index.html", data: []byte("<!doctype html>")},
			{raw: "site/app.js", want: "site/app.js", data: []byte("1")},
		}},
		{filename: "prepended.zip", prefix: bytes.Repeat([]byte("#!/bin/sh\nexit 0\n"), 64), entries: []entry{
			{raw: "a.txt", want: "a.txt", data: text},
			{raw: "b/c.txt", want: "b/c.txt", data: []byte("c"), store: true},
		}},
	}
}

func manyEntries(filename string, n int) fixture {
	entries := make([]entry, n)
	for i := range entries {
		name := fmt.Sprintf("d%03d/f%06d.txt", i/1000, i)
		entries[i] = entry{raw: name, want: name, data: []byte(name), store: i%2 == 0}
	}
	return fixture{filename: filename, entries: entries}
}

func largeFixtures() []fixture {
	return []fixture{
		manyEntries("zip64-70k.zip", 70_000),
		manyEntries("list-10k.zip", 10_000),
		manyEntries("list-100k.zip", 100_000),
	}
}

func deflate(data []byte) []byte {
	var b bytes.Buffer
	w, err := flate.NewWriter(&b, flate.BestCompression)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		log.Fatal(err)
	}
	if err := w.Close(); err != nil {
		log.Fatal(err)
	}
	return b.Bytes()
}

func writeEntry(zw *zip.Writer, e entry) error {
	method := zip.Deflate
	if e.store || e.raw[len(e.raw)-1] == '/' {
		method = zip.Store
	}
	h := &zip.FileHeader{Name: e.raw, Method: method, NonUTF8: e.nonUTF8, Extra: e.extra}
	if e.descriptor || e.raw[len(e.raw)-1] == '/' {
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		_, err = w.Write(e.data)
		return err
	}
	body := e.data
	if method == zip.Deflate {
		body = deflate(e.data)
	}
	h.CRC32 = crc32.ChecksumIEEE(e.data)
	h.UncompressedSize64 = uint64(len(e.data))
	h.CompressedSize64 = uint64(len(body))
	w, err := zw.CreateRaw(h)
	if err != nil {
		return err
	}
	_, err = w.Write(body)
	return err
}

func writeFixture(out string, f fixture) error {
	var b bytes.Buffer
	b.Write(f.prefix)
	zw := zip.NewWriter(&b)
	for _, e := range f.entries {
		if err := writeEntry(zw, e); err != nil {
			return fmt.Errorf("%s %q: %w", f.filename, e.raw, err)
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, f.filename), b.Bytes(), 0o644); err != nil {
		return err
	}

	last := map[string]entry{}
	for _, e := range f.entries {
		if e.want != "" {
			last[e.want] = e
		}
	}
	g := golden{Archive: f.filename, Entries: []goldenEntry{}}
	for path, e := range last {
		g.Entries = append(g.Entries, goldenEntry{Path: path, Size: len(e.data), CRC32: fmt.Sprintf("%08x", crc32.ChecksumIEEE(e.data))})
	}
	sort.Slice(g.Entries, func(i, j int) bool { return g.Entries[i].Path < g.Entries[j].Path })
	js, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		return err
	}
	name := f.filename[:len(f.filename)-len(filepath.Ext(f.filename))] + ".golden.json"
	return os.WriteFile(filepath.Join(out, name), append(js, '\n'), 0o644)
}

func main() {
	out := flag.String("out", "data", "output directory")
	large := flag.Bool("large", false, "write the Zip64 and many-entry fixtures instead of the small ones")
	flag.Parse()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	fixtures := smallFixtures()
	if *large {
		fixtures = largeFixtures()
	}
	for _, f := range fixtures {
		if err := writeFixture(*out, f); err != nil {
			log.Fatal(err)
		}
	}
}
