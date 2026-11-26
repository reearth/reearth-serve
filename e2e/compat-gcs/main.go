// Command compat-gcs drives Serve's GCS compatibility API (ADR-019) with the
// Go storage client Re:Earth CMS uses, pinned to the same version, and runs
// one named scenario. It exits non-zero when the scenario's expectation fails.
//
// Environment:
//
//	E2E_ENDPOINT          Serve's apex URL, e.g. http://localhost:8788
//	E2E_COMPAT_GCS_HOST   COMPAT_GCS_HOST of that server, e.g. storage.localhost:8788
//	E2E_GCS_KEY_FILE      path to a key file issued by Serve
//	E2E_GCS_BUCKET        the bucket the key file's credential is bound to
//	E2E_GCS_REVOKE_URL    (revoked) the REST URL that revokes the credential
//	E2E_GCS_REVOKE_TOKEN  (revoked) an admin bearer token for that URL
//	E2E_COMPAT_SIGNED_PATH_PREFIX  (signed-put) COMPAT_SIGNED_PATH_PREFIX of that server, if set
//	E2E_GZIP_PASSTHROUGH  (read) "false" where a proxy rewrites gzip responses in front of Serve, as under wrangler dev, where ReadCompressed(true) receives decompressed bytes (see e2e/compression.test.ts)
//
// The compat host is a Host header on the e2e server's port, and its name
// need not resolve. Every connection is dialled to E2E_ENDPOINT's address
// instead, by replacing the dialers of http.DefaultTransport before the client
// is built: the client and its token source both clone that transport, so the
// key file and the endpoint option take their real code paths, and the
// requests still carry the compat host in Host and in the token audience.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

type config struct {
	endpoint    *url.URL
	compatHost  string
	keyFile     string
	bucket      string
	revokeURL   string
	revokeToken string
	pathPrefix  string
}

var scenarios = map[string]func(context.Context, *storage.Client, config) error{
	"attrs-missing":           attrsMissing,
	"revoked":                 revoked,
	"write-attrs-list-delete": writeAttrsListDelete,
	"paging":                  paging,
	"race":                    race,
	"resumable-40m":           resumable40M,
	"resumable-16m":           resumable16M,
	"signed-put":              signedPut,
	"signed-refusals":         signedRefusals,
	"read":                    read,
}

func main() {
	if len(os.Args) != 2 || scenarios[os.Args[1]] == nil {
		fmt.Fprintln(os.Stderr, "usage: compat-gcs <attrs-missing|revoked|write-attrs-list-delete|paging|race|resumable-40m|resumable-16m|signed-put|signed-refusals|read>")
		os.Exit(2)
	}
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	dialEverythingTo(cfg.endpoint.Host)
	sendHTTPSInPlaintext()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	client, err := storage.NewClient(ctx,
		option.WithEndpoint("http://"+cfg.compatHost+"/storage/v1/"),
		option.WithCredentialsFile(cfg.keyFile),
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, "new client:", err)
		os.Exit(1)
	}
	defer func() { _ = client.Close() }()

	if err := scenarios[os.Args[1]](ctx, client, cfg); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
}

func loadConfig() (config, error) {
	endpoint, err := url.Parse(os.Getenv("E2E_ENDPOINT"))
	if err != nil || endpoint.Host == "" {
		return config{}, fmt.Errorf("E2E_ENDPOINT must be a URL, got %q", os.Getenv("E2E_ENDPOINT"))
	}
	cfg := config{
		endpoint:    endpoint,
		compatHost:  os.Getenv("E2E_COMPAT_GCS_HOST"),
		keyFile:     os.Getenv("E2E_GCS_KEY_FILE"),
		bucket:      os.Getenv("E2E_GCS_BUCKET"),
		revokeURL:   os.Getenv("E2E_GCS_REVOKE_URL"),
		revokeToken: os.Getenv("E2E_GCS_REVOKE_TOKEN"),
		pathPrefix:  os.Getenv("E2E_COMPAT_SIGNED_PATH_PREFIX"),
	}
	if cfg.compatHost == "" || cfg.keyFile == "" || cfg.bucket == "" {
		return config{}, errors.New("E2E_COMPAT_GCS_HOST, E2E_GCS_KEY_FILE and E2E_GCS_BUCKET are required")
	}
	return cfg, nil
}

func dialEverythingTo(address string) {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, address)
	}
	http.DefaultTransport.(*http.Transport).DialContext = dial
}

// sendHTTPSInPlaintext makes https URLs reach the e2e server, which serves no
// TLS: the key file's token_uri takes BASE_URL's scheme, https under wrangler dev.
func sendHTTPSInPlaintext() {
	transport := http.DefaultTransport.(*http.Transport)
	transport.DialTLSContext = transport.DialContext
}

func attrsMissing(ctx context.Context, client *storage.Client, cfg config) error {
	_, err := client.Bucket(cfg.bucket).Object("assets/ab/missing.txt").Attrs(ctx)
	if !errors.Is(err, storage.ErrObjectNotExist) {
		return fmt.Errorf("Attrs on a missing key: want ErrObjectNotExist, got %v", err)
	}
	fmt.Println(err)
	return nil
}

func revoked(ctx context.Context, client *storage.Client, cfg config) error {
	if cfg.revokeURL == "" || cfg.revokeToken == "" {
		return errors.New("E2E_GCS_REVOKE_URL and E2E_GCS_REVOKE_TOKEN are required")
	}
	if err := attrsMissing(ctx, client, cfg); err != nil {
		return fmt.Errorf("before revocation: %w", err)
	}
	if err := revoke(ctx, cfg); err != nil {
		return err
	}
	_, err := client.Bucket(cfg.bucket).Object("assets/ab/missing.txt").Attrs(ctx)
	var apiErr *googleapi.Error
	if !errors.As(err, &apiErr) || apiErr.Code != http.StatusUnauthorized {
		return fmt.Errorf("Attrs with the cached token after revocation: want a 401, got %v", err)
	}
	fmt.Println("after revocation:", apiErr.Code)
	return nil
}

func revoke(ctx context.Context, cfg config) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, cfg.revokeURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.revokeToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("revoke: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusNoContent {
		return fmt.Errorf("revoke: want 204, got %d", res.StatusCode)
	}
	return nil
}

func write(ctx context.Context, obj *storage.ObjectHandle, contentType, contentEncoding string, metadata map[string]string, data []byte) (*storage.ObjectAttrs, error) {
	w := obj.NewWriter(ctx)
	w.ContentType = contentType
	w.ContentEncoding = contentEncoding
	w.Metadata = metadata
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return w.Attrs(), nil
}

func checkHashes(attrs *storage.ObjectAttrs, data []byte) error {
	wantCRC := crc32.Checksum(data, crc32.MakeTable(crc32.Castagnoli))
	wantMD5 := md5.Sum(data)
	if attrs.CRC32C != wantCRC {
		return fmt.Errorf("CRC32C: want %08x, got %08x", wantCRC, attrs.CRC32C)
	}
	if !bytes.Equal(attrs.MD5, wantMD5[:]) {
		return fmt.Errorf("MD5: want %x, got %x", wantMD5, attrs.MD5)
	}
	return nil
}

func writeAttrsListDelete(ctx context.Context, client *storage.Client, cfg config) error {
	bucket := client.Bucket(cfg.bucket)
	obj := bucket.Object("assets/ab/cdef/a.txt")
	first := []byte("small body")
	if _, err := write(ctx, obj, "text/plain", "", map[string]string{"k": "v"}, first); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	attrs, err := obj.Attrs(ctx)
	if err != nil {
		return fmt.Errorf("attrs: %w", err)
	}
	if err := checkHashes(attrs, first); err != nil {
		return err
	}
	if attrs.ContentType != "text/plain" || attrs.Metadata["k"] != "v" || attrs.Size != int64(len(first)) {
		return fmt.Errorf("attrs: got ContentType %q, Metadata %v, Size %d", attrs.ContentType, attrs.Metadata, attrs.Size)
	}
	firstGeneration := attrs.Generation

	second := []byte("second, longer body")
	if _, err := write(ctx, obj, "text/plain", "", nil, second); err != nil {
		return fmt.Errorf("overwrite: %w", err)
	}
	attrs, err = obj.Attrs(ctx)
	if err != nil {
		return fmt.Errorf("attrs after overwrite: %w", err)
	}
	if err := checkHashes(attrs, second); err != nil {
		return fmt.Errorf("after overwrite: %w", err)
	}
	if attrs.Generation <= firstGeneration {
		return fmt.Errorf("overwrite: generation %d is not above %d", attrs.Generation, firstGeneration)
	}
	fmt.Println("overwrite: generation increased")
	lastGeneration := attrs.Generation

	if _, err := write(ctx, bucket.Object("assets/ab/cdef/sub/b.txt"), "text/plain", "", nil, []byte("b")); err != nil {
		return fmt.Errorf("write sub/b.txt: %w", err)
	}
	var objects, prefixes []string
	it := bucket.Objects(ctx, &storage.Query{Prefix: "assets/ab/cdef/", Delimiter: "/"})
	for {
		item, err := it.Next()
		if errors.Is(err, iterator.Done) {
			break
		}
		if err != nil {
			return fmt.Errorf("list: %w", err)
		}
		if item.Prefix != "" {
			prefixes = append(prefixes, item.Prefix)
		} else {
			objects = append(objects, item.Name)
		}
	}
	if len(objects) != 1 || objects[0] != "assets/ab/cdef/a.txt" || len(prefixes) != 1 || prefixes[0] != "assets/ab/cdef/sub/" {
		return fmt.Errorf("list: want one object and one prefix, got %v and %v", objects, prefixes)
	}
	fmt.Println("listed:", objects, prefixes)

	for _, name := range []string{"assets/ab/cdef/a.txt", "assets/ab/cdef/a.txt", "never/written.txt"} {
		if err := bucket.Object(name).Delete(ctx); err != nil {
			return fmt.Errorf("delete %s: %w", name, err)
		}
		fmt.Println("deleted:", name)
	}
	if _, err := obj.Attrs(ctx); !errors.Is(err, storage.ErrObjectNotExist) {
		return fmt.Errorf("attrs after delete: want ErrObjectNotExist, got %v", err)
	}

	recreated, err := write(ctx, obj, "text/plain", "", nil, first)
	if err != nil {
		return fmt.Errorf("recreate: %w", err)
	}
	if recreated.Generation <= lastGeneration {
		return fmt.Errorf("recreate: generation %d is not above %d", recreated.Generation, lastGeneration)
	}
	fmt.Println("recreate: generation increased")
	if err := obj.Delete(ctx); err != nil {
		return fmt.Errorf("delete recreated: %w", err)
	}
	return nil
}

const pagingKeys = 1050

func paging(ctx context.Context, client *storage.Client, cfg config) error {
	bucket := client.Bucket(cfg.bucket)
	names := make(chan string)
	errs := make(chan error, pagingKeys)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for name := range names {
				if _, err := write(ctx, bucket.Object(name), "text/plain", "", nil, []byte(name)); err != nil {
					errs <- fmt.Errorf("write %s: %w", name, err)
				}
			}
		}()
	}
	for i := range pagingKeys {
		names <- fmt.Sprintf("paging/%05d.txt", i)
	}
	close(names)
	wg.Wait()
	close(errs)
	if err := <-errs; err != nil {
		return err
	}

	seen := map[string]int{}
	it := bucket.Objects(ctx, &storage.Query{Prefix: "paging/"})
	for {
		item, err := it.Next()
		if errors.Is(err, iterator.Done) {
			break
		}
		if err != nil {
			return fmt.Errorf("list: %w", err)
		}
		seen[item.Name]++
	}
	for i := range pagingKeys {
		if name := fmt.Sprintf("paging/%05d.txt", i); seen[name] != 1 {
			return fmt.Errorf("list: %s seen %d times", name, seen[name])
		}
	}
	if len(seen) != pagingKeys {
		return fmt.Errorf("list: want %d keys, got %d", pagingKeys, len(seen))
	}
	fmt.Println("listed:", len(seen))
	return nil
}

// The Go client does not retry an upload without preconditions by default,
// so both writers opt in to retries.
func race(ctx context.Context, client *storage.Client, cfg config) error {
	obj := client.Bucket(cfg.bucket).Object("race/new.txt").Retryer(storage.WithPolicy(storage.RetryAlways))
	start := make(chan struct{})
	errs := make([]error, 2)
	written := make([]*storage.ObjectAttrs, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			written[i], errs[i] = write(ctx, obj, "text/plain", "", nil, []byte(fmt.Sprintf("writer %d", i)))
		}()
	}
	close(start)
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return err
	}
	attrs, err := obj.Attrs(ctx)
	if err != nil {
		return fmt.Errorf("attrs: %w", err)
	}
	low, high := written[0].Generation, written[1].Generation
	if low > high {
		low, high = high, low
	}
	if low == high || attrs.Generation != high {
		return fmt.Errorf("race: writers got generations %d and %d, the object has %d", low, high, attrs.Generation)
	}
	fmt.Println("generation: the later of two distinct writes")
	return nil
}

const mib = 1 << 20

func readAll(r *storage.Reader, err error) ([]byte, storage.ReaderObjectAttrs, error) {
	if err != nil {
		return nil, storage.ReaderObjectAttrs{}, err
	}
	defer func() { _ = r.Close() }()
	data, err := io.ReadAll(r)
	return data, r.Attrs, err
}

func read(ctx context.Context, client *storage.Client, cfg config) error {
	bucket := client.Bucket(cfg.bucket)
	plain := bucket.Object("read/plain.bin")
	data := pattern(256*1024, 7)
	if _, err := write(ctx, plain, "application/octet-stream", "", nil, data); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	defer func() { _ = plain.Delete(ctx) }()

	got, attrs, err := readAll(plain.NewReader(ctx))
	if err != nil {
		return fmt.Errorf("NewReader: %w", err)
	}
	if !bytes.Equal(got, data) {
		return fmt.Errorf("NewReader: %d bytes differ from the %d written", len(got), len(data))
	}
	if want := crc32.Checksum(data, crc32.MakeTable(crc32.Castagnoli)); attrs.CRC32C != want || attrs.Decompressed {
		return fmt.Errorf("NewReader: want CRC32C %08x checked on the stored bytes, got %08x (decompressed %v)", want, attrs.CRC32C, attrs.Decompressed)
	}
	fmt.Printf("read: %d bytes, CRC32C %08x checked\n", len(got), attrs.CRC32C)

	head, attrs, err := readAll(plain.NewRangeReader(ctx, 0, 5))
	if err != nil {
		return fmt.Errorf("NewRangeReader: %w", err)
	}
	if !bytes.Equal(head, data[:5]) || attrs.Size != int64(len(data)) || attrs.CRC32C != 0 {
		return fmt.Errorf("NewRangeReader(0, 5): got %x of %d (CRC32C %08x), want %x of %d and no hash", head, attrs.Size, attrs.CRC32C, data[:5], len(data))
	}
	fmt.Printf("range: %x\n", head)

	for _, r := range []struct {
		offset, length int64
		want           []byte
	}{{990, -1, data[990:]}, {-5, -1, data[len(data)-5:]}} {
		got, _, err := readAll(plain.NewRangeReader(ctx, r.offset, r.length))
		if err != nil {
			return fmt.Errorf("NewRangeReader(%d, %d): %w", r.offset, r.length, err)
		}
		if !bytes.Equal(got, r.want) {
			return fmt.Errorf("NewRangeReader(%d, %d): got %d bytes, want %d", r.offset, r.length, len(got), len(r.want))
		}
	}
	fmt.Println("range from 990 and suffix: bytes match")

	if err := readGzip(ctx, bucket); err != nil {
		return err
	}

	_, _, err = readAll(bucket.Object("read/missing.bin").NewReader(ctx))
	if !errors.Is(err, storage.ErrObjectNotExist) {
		return fmt.Errorf("NewReader on a missing key: want ErrObjectNotExist, got %v", err)
	}
	fmt.Println("missing: ErrObjectNotExist")
	return nil
}

func readGzip(ctx context.Context, bucket *storage.BucketHandle) error {
	obj := bucket.Object("read/data.json")
	doc := bytes.Repeat([]byte(`{"type":"Feature","properties":{}}`), 512)
	var packed bytes.Buffer
	zw := gzip.NewWriter(&packed)
	if _, err := zw.Write(doc); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if _, err := write(ctx, obj, "application/json", "gzip", nil, packed.Bytes()); err != nil {
		return fmt.Errorf("gzip write: %w", err)
	}
	defer func() { _ = obj.Delete(ctx) }()

	if os.Getenv("E2E_GZIP_PASSTHROUGH") == "false" {
		fmt.Println("gzip passthrough: not checked behind a decoding proxy")
	} else {
		stored, attrs, err := readAll(obj.ReadCompressed(true).NewReader(ctx))
		if err != nil {
			return fmt.Errorf("ReadCompressed(true): %w", err)
		}
		if !bytes.Equal(stored, packed.Bytes()) || attrs.Decompressed {
			return fmt.Errorf("ReadCompressed(true): got %d bytes (decompressed %v), want the %d stored gzip bytes", len(stored), attrs.Decompressed, packed.Len())
		}
		fmt.Printf("gzip passthrough: %d stored bytes, Decompressed false\n", len(stored))
	}

	plain, _, err := readAll(obj.ReadCompressed(false).NewReader(ctx))
	if err != nil {
		return fmt.Errorf("ReadCompressed(false): %w", err)
	}
	if !bytes.Equal(plain, doc) {
		return fmt.Errorf("ReadCompressed(false): got %d bytes, want the %d decompressed bytes", len(plain), len(doc))
	}
	fmt.Printf("gzip decompressed: %d bytes\n", len(plain))

	for _, r := range []struct{ offset, length int64 }{{0, 5}, {990, -1}, {-5, -1}} {
		got, attrs, err := readAll(obj.ReadCompressed(false).NewRangeReader(ctx, r.offset, r.length))
		if err != nil {
			return fmt.Errorf("gzip NewRangeReader(%d, %d): %w", r.offset, r.length, err)
		}
		if !bytes.Equal(got, doc) || !attrs.Decompressed {
			return fmt.Errorf("gzip NewRangeReader(%d, %d): got %d bytes (decompressed %v), want the whole %d-byte object as GCS serves it", r.offset, r.length, len(got), attrs.Decompressed, len(doc))
		}
	}
	fmt.Println("gzip ranges: whole object, as under decompressive transcoding")
	return nil
}

func pattern(size int, seed byte) []byte {
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i*31) ^ seed ^ byte(i>>16)
	}
	return data
}

func writeResumable(ctx context.Context, obj *storage.ObjectHandle, data []byte) (*storage.ObjectAttrs, error) {
	w := obj.NewWriter(ctx)
	w.ContentType = "application/octet-stream"
	w.ProgressFunc = func(n int64) { fmt.Println("chunk acknowledged:", n) }
	started := time.Now()
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "wrote %d bytes in %s\n", len(data), time.Since(started))
	attrs, err := obj.Attrs(ctx)
	if err != nil {
		return nil, fmt.Errorf("attrs: %w", err)
	}
	if attrs.Size != int64(len(data)) {
		return nil, fmt.Errorf("size: want %d, got %d", len(data), attrs.Size)
	}
	if err := checkHashes(attrs, data); err != nil {
		return nil, err
	}
	if attrs.Generation != w.Attrs().Generation {
		return nil, fmt.Errorf("generation: the write returned %d, Attrs reads %d", w.Attrs().Generation, attrs.Generation)
	}
	fmt.Println("committed:", attrs.Size, "bytes")
	return attrs, nil
}

func resumable40M(ctx context.Context, client *storage.Client, cfg config) error {
	obj := client.Bucket(cfg.bucket).Object("resumable/40m.bin")
	first, err := writeResumable(ctx, obj, pattern(40*mib, 1))
	if err != nil {
		return fmt.Errorf("write: %w", err)
	}
	second, err := writeResumable(ctx, obj, pattern(40*mib, 2))
	if err != nil {
		return fmt.Errorf("overwrite: %w", err)
	}
	if second.Generation <= first.Generation {
		return fmt.Errorf("overwrite: generation %d is not above %d", second.Generation, first.Generation)
	}
	fmt.Println("overwrite: generation increased")
	return nil
}

// resumable16M ends on a chunk boundary, so the client finishes with an empty
// request whose Content-Range is bytes */16777216.
func resumable16M(ctx context.Context, client *storage.Client, cfg config) error {
	_, err := writeResumable(ctx, client.Bucket(cfg.bucket).Object("resumable/16m.bin"), pattern(16*mib, 3))
	return err
}

// cmsSignedURL signs a PUT the way CMS IssueUploadAssetLink does.
func cmsSignedURL(client *storage.Client, cfg config, key string, expires time.Duration, headers ...string) (string, error) {
	return client.Bucket(cfg.bucket).SignedURL(key, &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      http.MethodPut,
		Expires:     time.Now().Add(expires),
		ContentType: "application/geo+json",
		QueryParameters: map[string][]string{
			"reearth-x-workspace": {"ws1"},
			"reearth-x-project":   {"p1"},
			"reearth-x-public":    {"true"},
		},
		Headers: append([]string{"Content-Encoding: gzip"}, headers...),
	})
}

func sendSigned(ctx context.Context, method, rawURL, contentType string, body []byte, headers ...string) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Content-Encoding", "gzip")
	for _, h := range headers {
		name, value, _ := strings.Cut(h, ":")
		req.Header.Set(name, strings.TrimSpace(value))
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = res.Body.Close() }()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, "", err
	}
	code := ""
	if m := xmlCode.FindSubmatch(text); m != nil {
		code = string(m[1])
	}
	return res.StatusCode, code, nil
}

var xmlCode = regexp.MustCompile(`<Code>([^<]+)</Code>`)

func putSigned(ctx context.Context, client *storage.Client, cfg config, key, rawURL string, data []byte) error {
	status, code, err := sendSigned(ctx, http.MethodPut, rawURL, "application/geo+json", data)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("signed PUT of %s: want 200, got %d %s", key, status, code)
	}
	attrs, err := client.Bucket(cfg.bucket).Object(key).Attrs(ctx)
	if err != nil {
		return fmt.Errorf("attrs: %w", err)
	}
	if err := checkHashes(attrs, data); err != nil {
		return err
	}
	if attrs.ContentType != "application/geo+json" || attrs.ContentEncoding != "gzip" {
		return fmt.Errorf("attrs: want application/geo+json and gzip, got %s and %s", attrs.ContentType, attrs.ContentEncoding)
	}
	fmt.Printf("signed PUT: %d, Attrs MD5 matches %x\n", status, attrs.MD5)
	return nil
}

func signedPut(ctx context.Context, client *storage.Client, cfg config) error {
	key := "assets/ab/cdef/signed (1).geojson"
	signed, err := cmsSignedURL(client, cfg, key, 15*time.Minute)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	if err := putSigned(ctx, client, cfg, key, signed, pattern(1024, 4)); err != nil {
		return err
	}
	if err := signedMetadata(ctx, client, cfg); err != nil {
		return err
	}
	if cfg.pathPrefix == "" {
		return nil
	}
	key = "assets/ab/cdef/rewritten.geojson"
	signed, err = cmsSignedURL(client, cfg, key, 15*time.Minute)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	rewritten, err := url.Parse(signed)
	if err != nil {
		return err
	}
	rewritten.Scheme = "http"
	rewritten.Path = path.Join(cfg.pathPrefix, rewritten.Path)
	return putSigned(ctx, client, cfg, key, rewritten.String(), pattern(512, 5))
}

func signedMetadata(ctx context.Context, client *storage.Client, cfg config) error {
	key := "assets/ab/cdef/meta.geojson"
	owner := "x-goog-meta-owner: alice"
	signed, err := cmsSignedURL(client, cfg, key, 15*time.Minute, owner)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	status, code, err := sendSigned(ctx, http.MethodPut, signed, "application/geo+json", []byte("m"), owner)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("signed PUT with metadata: want 200, got %d %s", status, code)
	}
	attrs, err := client.Bucket(cfg.bucket).Object(key).Attrs(ctx)
	if err != nil {
		return fmt.Errorf("attrs: %w", err)
	}
	fmt.Printf("signed x-goog-meta-owner: Attrs metadata owner=%s\n", attrs.Metadata["owner"])
	return nil
}

func signedHeaderRefusals(ctx context.Context, client *storage.Client, cfg config) error {
	approved := md5.Sum([]byte("approved"))
	md5URL, err := client.Bucket(cfg.bucket).SignedURL("assets/ab/cdef/md5.geojson", &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      http.MethodPut,
		Expires:     time.Now().Add(15 * time.Minute),
		ContentType: "application/geo+json",
		MD5:         base64.StdEncoding.EncodeToString(approved[:]),
		Headers:     []string{"Content-Encoding: gzip"},
	})
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	cases := []struct {
		name, key, header string
		body              []byte
	}{
		{"content-md5 of other bytes", "md5.geojson", "Content-MD5: " + base64.StdEncoding.EncodeToString(approved[:]), []byte("tampered")},
		{"outside x-goog-content-length-range", "range.geojson", "x-goog-content-length-range: 0,1", []byte("xx")},
		{"create-only over an existing object", "once.geojson", "x-goog-if-generation-match: 0", []byte("x")},
		{"unsupported signed header", "acl.geojson", "x-goog-acl: private", []byte("x")},
	}
	for _, c := range cases {
		signed := md5URL
		if c.key != "md5.geojson" {
			if signed, err = cmsSignedURL(client, cfg, "assets/ab/cdef/"+c.key, 15*time.Minute, c.header); err != nil {
				return fmt.Errorf("sign: %w", err)
			}
		}
		if c.key == "once.geojson" {
			if status, code, err := sendSigned(ctx, http.MethodPut, signed, "application/geo+json", c.body, c.header); err != nil || status != http.StatusOK {
				return fmt.Errorf("create-only first PUT: %d %s %v", status, code, err)
			}
		}
		status, code, err := sendSigned(ctx, http.MethodPut, signed, "application/geo+json", c.body, c.header)
		if err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
		fmt.Printf("%s: %d %s\n", c.name, status, code)
	}
	return nil
}

func signedRefusals(ctx context.Context, client *storage.Client, cfg config) error {
	if cfg.revokeURL == "" || cfg.revokeToken == "" {
		return errors.New("E2E_GCS_REVOKE_URL and E2E_GCS_REVOKE_TOKEN are required")
	}
	key := "assets/ab/cdef/refused.geojson"
	signed, err := cmsSignedURL(client, cfg, key, 15*time.Minute)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	short, err := cmsSignedURL(client, cfg, key, 2*time.Second)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	time.Sleep(3 * time.Second)
	cases := []struct {
		name, method, url, contentType string
	}{
		{"tampered content type", http.MethodPut, signed, "text/plain"},
		{"expired", http.MethodPut, short, "application/geo+json"},
		{"other key", http.MethodPut, strings.Replace(signed, "refused.geojson", "other.geojson", 1), "application/geo+json"},
		{"wrong method", http.MethodGet, signed, "application/geo+json"},
	}
	for _, c := range cases {
		status, code, err := sendSigned(ctx, c.method, c.url, c.contentType, []byte("x"))
		if err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
		fmt.Printf("%s: %d %s\n", c.name, status, code)
	}
	if err := signedHeaderRefusals(ctx, client, cfg); err != nil {
		return err
	}
	if err := revoke(ctx, cfg); err != nil {
		return err
	}
	status, code, err := sendSigned(ctx, http.MethodPut, signed, "application/geo+json", []byte("x"))
	if err != nil {
		return fmt.Errorf("revoked: %w", err)
	}
	fmt.Printf("revoked: %d %s\n", status, code)
	return nil
}
