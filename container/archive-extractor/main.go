package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
)

func main() {
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

	worker := NewExtractionWorker(r2, ExtractionConfig{
		AssetID:         cfg.AssetID,
		ArchiveKey:      cfg.ArchiveKey,
		ArchiveFilename: cfg.ArchiveFilename,
		ArchiveFormat:   cfg.ArchiveFormat,
		WorkerAPIURL:    cfg.WorkerAPIURL,
		MaxConcurrency:  cfg.MaxConcurrency,
		CheckpointEvery: cfg.CheckpointEvery,
	})

	if err := worker.Run(ctx); err != nil {
		// Update job status to failed
		_ = worker.updateJobStatus(ctx, "failed", 0, 0)
		log.Fatalf("extraction failed: %v", err)
	}
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
	WorkerAPIURL string

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
