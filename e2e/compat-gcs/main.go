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
	"context"
	"crypto/md5"
	"errors"
	"fmt"
	"hash/crc32"
	"net"
	"net/http"
	"net/url"
	"os"
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
}

var scenarios = map[string]func(context.Context, *storage.Client, config) error{
	"attrs-missing":           attrsMissing,
	"revoked":                 revoked,
	"write-attrs-list-delete": writeAttrsListDelete,
	"paging":                  paging,
	"race":                    race,
}

func main() {
	if len(os.Args) != 2 || scenarios[os.Args[1]] == nil {
		fmt.Fprintln(os.Stderr, "usage: compat-gcs <attrs-missing|revoked|write-attrs-list-delete|paging|race>")
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

func write(ctx context.Context, obj *storage.ObjectHandle, contentType string, metadata map[string]string, data []byte) (*storage.ObjectAttrs, error) {
	w := obj.NewWriter(ctx)
	w.ContentType = contentType
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
	if _, err := write(ctx, obj, "text/plain", map[string]string{"k": "v"}, first); err != nil {
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
	fmt.Println("generation:", attrs.Generation)

	second := []byte("second, longer body")
	if _, err := write(ctx, obj, "text/plain", nil, second); err != nil {
		return fmt.Errorf("overwrite: %w", err)
	}
	attrs, err = obj.Attrs(ctx)
	if err != nil {
		return fmt.Errorf("attrs after overwrite: %w", err)
	}
	if err := checkHashes(attrs, second); err != nil {
		return fmt.Errorf("after overwrite: %w", err)
	}
	fmt.Println("generation:", attrs.Generation)

	if _, err := write(ctx, bucket.Object("assets/ab/cdef/sub/b.txt"), "text/plain", nil, []byte("b")); err != nil {
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
				if _, err := write(ctx, bucket.Object(name), "text/plain", nil, []byte(name)); err != nil {
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
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, errs[i] = write(ctx, obj, "text/plain", nil, []byte(fmt.Sprintf("writer %d", i)))
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
	fmt.Println("generation:", attrs.Generation)
	return nil
}
