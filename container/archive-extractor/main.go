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
		Endpoint:        cfg.R2Endpoint,
		AccessKeyID:     cfg.R2AccessKeyID,
		SecretAccessKey: cfg.R2SecretAccessKey,
		Bucket:          cfg.R2Bucket,
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

	log.Printf("config: endpoint=%s bucket=%s assetId=%s archiveKey=%s format=%s workerAPI=%s accessKeyId=%s...",
		cfg.R2Endpoint, cfg.R2Bucket, cfg.AssetID, cfg.ArchiveKey, cfg.ArchiveFormat, cfg.WorkerAPIURL,
		maskString(cfg.R2AccessKeyID))

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
	// R2 connection
	R2Endpoint        string
	R2AccessKeyID     string
	R2SecretAccessKey string
	R2Bucket          string

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
	cfg := &envConfig{
		R2Endpoint:        os.Getenv("R2_ENDPOINT"),
		R2AccessKeyID:     os.Getenv("R2_ACCESS_KEY_ID"),
		R2SecretAccessKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
		R2Bucket:          os.Getenv("R2_BUCKET"),
		AssetID:           os.Getenv("ASSET_ID"),
		ArchiveKey:        os.Getenv("ARCHIVE_KEY"),
		ArchiveFilename:   os.Getenv("ARCHIVE_FILENAME"),
		ArchiveFormat:     os.Getenv("ARCHIVE_FORMAT"),
		WorkerAPIURL:      os.Getenv("WORKER_API_URL"),
		InternalAPISecret: os.Getenv("INTERNAL_API_SECRET"),
		MaxConcurrency:    48,
		CheckpointEvery:   100,
	}

	// Required fields
	for _, kv := range []struct{ name, val string }{
		{"R2_ENDPOINT", cfg.R2Endpoint},
		{"R2_ACCESS_KEY_ID", cfg.R2AccessKeyID},
		{"R2_SECRET_ACCESS_KEY", cfg.R2SecretAccessKey},
		{"R2_BUCKET", cfg.R2Bucket},
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
	if v := os.Getenv("MAX_CONCURRENCY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid MAX_CONCURRENCY: %w", err)
		}
		cfg.MaxConcurrency = n
	}
	if v := os.Getenv("CHECKPOINT_EVERY"); v != "" {
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
