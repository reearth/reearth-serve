package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
)

// Name decoding shared with the in-place listing (core/archive/names.ts).
// Both must give every zip entry the same path, or a listed path would not be
// the key the extractor writes.

const (
	utf8Flag         = 0x0800
	unicodePathExtra = 0x7075
)

var cp437High = []rune("ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ")

var utf8BOM = []byte{0xef, 0xbb, 0xbf}

// zipNames decodes every central directory name with one rule per archive:
// a name flagged UTF-8, all ASCII, or valid UTF-8 is UTF-8; otherwise a
// matching Info-ZIP Unicode Path extra; otherwise the remaining names are
// Shift_JIS when every one of them decodes strictly, and CP437 when not.
func zipNames(files []*zip.File) []string {
	names := make([]string, len(files))
	var legacy []int
	allShiftJIS := true
	for i, f := range files {
		if name, ok := unicodeName(f); ok {
			names[i] = name
			continue
		}
		legacy = append(legacy, i)
		if _, ok := decodeShiftJIS([]byte(f.Name)); !ok {
			allShiftJIS = false
		}
	}
	for _, i := range legacy {
		raw := []byte(files[i].Name)
		if name, ok := decodeShiftJIS(raw); allShiftJIS && ok {
			names[i] = name
		} else {
			names[i] = decodeCP437(raw)
		}
	}
	return names
}

func unicodeName(f *zip.File) (string, bool) {
	raw := []byte(f.Name)
	if f.Flags&utf8Flag != 0 || isASCII(raw) {
		if name, ok := decodeUTF8(raw); ok {
			return name, true
		}
		return decodeCP437(raw), true
	}
	if name, ok := decodeUTF8(raw); ok {
		return name, true
	}
	if extra := unicodePath(raw, f.Extra); extra != nil {
		if name, ok := decodeUTF8(extra); ok && name != "" {
			return name, true
		}
	}
	return "", false
}

// unicodePath returns the last version-1 Unicode Path extra whose CRC-32
// matches the raw name, or nil.
func unicodePath(raw, extra []byte) []byte {
	var found []byte
	for len(extra) >= 4 {
		id := binary.LittleEndian.Uint16(extra)
		size := int(binary.LittleEndian.Uint16(extra[2:]))
		if 4+size > len(extra) {
			break
		}
		body := extra[4 : 4+size]
		if id == unicodePathExtra && size >= 5 && body[0] == 1 && binary.LittleEndian.Uint32(body[1:]) == crc32.ChecksumIEEE(raw) {
			found = body[5:]
		}
		extra = extra[4+size:]
	}
	return found
}

// decodeUTF8 drops a leading byte order mark, as a WHATWG TextDecoder does.
func decodeUTF8(raw []byte) (string, bool) {
	if !utf8.Valid(raw) {
		return "", false
	}
	return string(bytes.TrimPrefix(raw, utf8BOM)), true
}

// decodeShiftJIS accepts only names every Shift_JIS decoder in play reads
// the same way. ICU (Node, workerd), WHATWG and x/text agree on the JIS X 0208
// and IBM extension pairs but not on 0x80, the user-defined area, or ICU's
// swap of 0x1A, 0x1C and 0x7F, so a name that decodes to any of those is not
// Shift_JIS.
func decodeShiftJIS(raw []byte) (string, bool) {
	out, err := japanese.ShiftJIS.NewDecoder().Bytes(raw)
	if err != nil {
		return "", false
	}
	name := string(out)
	if strings.ContainsFunc(name, func(r rune) bool {
		return r == utf8.RuneError || r == 0x80 || r == 0x1a || r == 0x1c || r == 0x7f || (r >= 0xe000 && r <= 0xf8ff)
	}) {
		return "", false
	}
	return name, true
}

func decodeCP437(raw []byte) string {
	var b strings.Builder
	for _, c := range raw {
		if c < 0x80 {
			b.WriteByte(c)
		} else {
			b.WriteRune(cp437High[c-0x80])
		}
	}
	return b.String()
}

func isASCII(raw []byte) bool {
	for _, c := range raw {
		if c >= 0x80 {
			return false
		}
	}
	return true
}

// ServedPath is where an entry is served under files/, or false when its
// normalized path escapes the archive root.
func ServedPath(name, rootPrefix string) (string, bool) {
	p := StripPrefix(NormalizeSeparators(name), rootPrefix)
	if p == "." || p == ".." || strings.HasPrefix(p, "../") || strings.HasPrefix(p, "/") {
		return "", false
	}
	return p, true
}
