package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
)

func main() {
	// Start health check server for Cloudflare Containers readiness detection
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		log.Fatal(http.ListenAndServe(":8080", mux))
	}()

	cfg, err := loadConfigFromEnv()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	ctx := context.Background()

	r2, err := NewR2Client(ctx, R2Config{
		Endpoint:        cfg.ObjectStore.Endpoint,
		AccessKeyID:     cfg.ObjectStore.AccessKeyID,
		SecretAccessKey: cfg.ObjectStore.SecretAccessKey,
		Bucket:          cfg.ObjectStore.Bucket,
		Region:          cfg.ObjectStore.Region,
		PathStyle:       cfg.ObjectStore.PathStyle,
	})
	if err != nil {
		log.Fatalf("failed to create R2 client: %v", err)
	}

	// Set up log writer that captures output for R2
	logBuf := &logBuffer{}
	log.SetOutput(io.MultiWriter(os.Stderr, logBuf))
	flushLogs := func() {
		logKey := fmt.Sprintf("assets/%s/_archive/_log.txt", cfg.AssetID)
		logStr := logBuf.String()
		if err := r2.PutObject(ctx, logKey, strings.NewReader(logStr), int64(len(logStr)), "text/plain", nil); err != nil {
			log.Printf("WARNING: failed to write log to R2: %v", err)
		} else {
			log.Printf("Log written to R2: %s", logKey)
		}
	}

	if msg := deprecationMessage(cfg.Deprecations); msg != "" {
		log.Print(msg)
	}

	log.Printf("config: endpoint=%s bucket=%s region=%s pathStyle=%t assetId=%s archiveKey=%s format=%s workerAPI=%s accessKeyId=%s...",
		cfg.ObjectStore.Endpoint, cfg.ObjectStore.Bucket, cfg.ObjectStore.Region, cfg.ObjectStore.PathStyle,
		cfg.AssetID, cfg.ArchiveKey, cfg.ArchiveFormat, cfg.WorkerAPIURL,
		maskString(cfg.ObjectStore.AccessKeyID))

	worker := NewExtractionWorker(r2, ExtractionConfig{
		AssetID:           cfg.AssetID,
		ArchiveKey:        cfg.ArchiveKey,
		ArchiveFilename:   cfg.ArchiveFilename,
		ArchiveFormat:     cfg.ArchiveFormat,
		WorkerAPIURL:      cfg.WorkerAPIURL,
		InternalAPISecret: cfg.InternalAPISecret,
		MaxConcurrency:    cfg.MaxConcurrency,
		CheckpointEvery:   cfg.CheckpointEvery,
	})

	if err := worker.Run(ctx); err != nil {
		log.Printf("extraction failed: %v", err)
		flushLogs()
		// Send error with truncated log for debugging
		logSummary := logBuf.String()
		if len(logSummary) > 500 {
			logSummary = logSummary[len(logSummary)-500:]
		}
		_ = worker.updateJobStatus(ctx, "failed", 0, 0, withError(err.Error()+"\n---LOG---\n"+logSummary))
		os.Exit(1)
	}

	flushLogs()
}

type envConfig struct {
	// Object store connection
	ObjectStore objectStoreConfig

	// Deprecated environment variable names that supplied the object store
	// configuration, if any.
	Deprecations []string

	// Extraction parameters
	AssetID         string
	ArchiveKey      string
	ArchiveFilename string
	ArchiveFormat   string

	// Worker API
	WorkerAPIURL      string
	InternalAPISecret string

	// Tuning
	MaxConcurrency  int
	CheckpointEvery int
}

func loadConfigFromEnv() (*envConfig, error) {
	return loadConfig(os.Getenv)
}

// loadConfig builds the configuration from env, which tests substitute.
// R2 is path-style, so path style defaults to true here.
func loadConfig(env getenv) (*envConfig, error) {
	objectStore, deprecations, err := loadObjectStoreConfig(env, true)
	if err != nil {
		return nil, err
	}

	cfg := &envConfig{
		ObjectStore:       objectStore,
		Deprecations:      deprecations,
		AssetID:           env("ASSET_ID"),
		ArchiveKey:        env("ARCHIVE_KEY"),
		ArchiveFilename:   env("ARCHIVE_FILENAME"),
		ArchiveFormat:     env("ARCHIVE_FORMAT"),
		WorkerAPIURL:      env("WORKER_API_URL"),
		InternalAPISecret: env("INTERNAL_API_SECRET"),
		// Default sized for the `standard-4` container tier (12 GiB memory)
		// configured in wrangler.toml. Each in-flight part holds up to
		// multipartPartSize (10 MiB) in a bytes.Buffer, so 48 concurrent
		// goroutines × ~10 MiB ≈ 480 MiB peak — comfortably under 12 GiB
		// with headroom for the gzip pipe, the S3 SDK, and the Go runtime.
		// If you shrink the container's `instance_type`, drop this
		// proportionally (e.g. `lite`/256 MiB wants ~12, `basic`/1 GiB ~48)
		// to avoid OOM kills. See docs/adr/008-extractor-capacity.md.
		MaxConcurrency:  48,
		CheckpointEvery: 100,
	}

	// Required fields
	for _, kv := range []struct{ name, val string }{
		{"ASSET_ID", cfg.AssetID},
		{"ARCHIVE_KEY", cfg.ArchiveKey},
		{"ARCHIVE_FILENAME", cfg.ArchiveFilename},
		{"ARCHIVE_FORMAT", cfg.ArchiveFormat},
	} {
		if kv.val == "" {
			return nil, fmt.Errorf("required environment variable %s is not set", kv.name)
		}
	}

	// Optional overrides
	if v := env("MAX_CONCURRENCY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid MAX_CONCURRENCY: %w", err)
		}
		cfg.MaxConcurrency = n
	}
	if v := env("CHECKPOINT_EVERY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid CHECKPOINT_EVERY: %w", err)
		}
		cfg.CheckpointEvery = n
	}

	return cfg, nil
}

// logBuffer is a thread-safe buffer that captures log output for writing to R2.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func maskString(s string) string {
	if len(s) <= 4 {
		return "***"
	}
	return s[:4] + "***"
}
