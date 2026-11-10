package main

// Integrity verification mode (ADR-017 §2, phase P1b).
//
// A presigned upload — multipart above all, up to 250 GiB — is stored without
// a whole-object SHA-256 the store can vouch for. This mode streams the object
// once, hashes it, and reports the hash to the Worker, which compares it with
// the declared one and keeps or deletes the upload. The container only hashes;
// it never sees the declared hash, so the decision lives in one place.
//
// It shares the extractor's image and launcher (same S3 client, same callback
// secret, same Durable Object class): the work is "read one object from the
// store and call back", which is what the extractor already does.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// modeVerify is the MODE value that selects this mode; anything else extracts.
const modeVerify = "verify"

// VerifyConfig is the verification run's parameters.
type VerifyConfig struct {
	JobID             string
	AssetID           string
	ObjectKey         string
	WorkerAPIURL      string
	InternalAPISecret string
}

func loadVerifyConfig(env getenv) (VerifyConfig, objectStoreConfig, []string, error) {
	objectStore, deprecations, err := loadObjectStoreConfig(env, true)
	if err != nil {
		return VerifyConfig{}, objectStoreConfig{}, nil, err
	}
	cfg := VerifyConfig{
		JobID:             env("JOB_ID"),
		AssetID:           env("ASSET_ID"),
		ObjectKey:         env("OBJECT_KEY"),
		WorkerAPIURL:      env("WORKER_API_URL"),
		InternalAPISecret: env("INTERNAL_API_SECRET"),
	}
	for _, kv := range []struct{ name, val string }{
		{"JOB_ID", cfg.JobID},
		{"OBJECT_KEY", cfg.ObjectKey},
	} {
		if kv.val == "" {
			return VerifyConfig{}, objectStoreConfig{}, nil, fmt.Errorf("required environment variable %s is not set", kv.name)
		}
	}
	return cfg, objectStore, deprecations, nil
}

// IntegrityVerifier hashes one stored object and reports the result.
type IntegrityVerifier struct {
	cfg        VerifyConfig
	storage    ObjectStorage
	httpClient *http.Client

	// readAttempts bounds how many times a broken read is resumed. Each resume
	// continues from the last byte hashed, so a 250 GiB object is never read
	// twice over one dropped connection.
	readAttempts int
	retryDelay   time.Duration
	// heartbeat is how often "running" is posted while hashing, so the
	// cleanup cron's stuck threshold tells a long hash from a dead container.
	heartbeat time.Duration
	// reportDelays spaces the attempts of the terminal callback.
	reportDelays []time.Duration
}

// NewIntegrityVerifier creates a verifier with production defaults.
func NewIntegrityVerifier(storage ObjectStorage, cfg VerifyConfig) *IntegrityVerifier {
	return &IntegrityVerifier{
		cfg:          cfg,
		storage:      storage,
		httpClient:   &http.Client{Timeout: workerAPITimeout},
		readAttempts: 5,
		retryDelay:   5 * time.Second,
		heartbeat:    statusUpdateInterval,
		reportDelays: statusRetryDelays,
	}
}

// errVerifyNotReported means the hash was computed but the Worker never
// acknowledged it; the job is re-run by the cron.
var errVerifyNotReported = errors.New("verification result not acknowledged by worker API")

// Run hashes the object and reports the result. A read that keeps failing is
// reported as a failure (transient: the Worker retries the job); the hash
// itself is reported as "completed" and judged by the Worker.
func (v *IntegrityVerifier) Run(ctx context.Context) error {
	log.Printf("verify: jobId=%s assetId=%s key=%s", v.cfg.JobID, v.cfg.AssetID, v.cfg.ObjectKey)
	_ = v.report(ctx, verifyPayload{Status: "running"})

	stop := v.startHeartbeat(ctx)
	sum, size, err := v.hashObject(ctx)
	stop()

	if err != nil {
		log.Printf("verify: read failed: %v", err)
		if rerr := v.reportWithRetry(ctx, verifyPayload{Status: "failed", Error: "integrity verification read failed: " + err.Error()}); rerr != nil {
			log.Printf("warning: failed to report verification failure: %v", rerr)
		}
		return err
	}

	log.Printf("verify: %d bytes hashed, sha256=%s", size, sum)
	if err := v.reportWithRetry(ctx, verifyPayload{Status: "completed", Sha256: sum}); err != nil {
		return fmt.Errorf("%w: %v", errVerifyNotReported, err)
	}
	return nil
}

// hashObject streams the object through SHA-256, resuming a broken read at the
// offset it reached. Returns the lowercase hex digest and the bytes hashed.
func (v *IntegrityVerifier) hashObject(ctx context.Context) (string, int64, error) {
	size, err := v.storage.HeadObject(ctx, v.cfg.ObjectKey)
	if err != nil {
		return "", 0, fmt.Errorf("head %s: %w", v.cfg.ObjectKey, err)
	}

	h := sha256.New()
	var offset int64
	var lastErr error
	for attempt := 1; attempt <= v.readAttempts; attempt++ {
		n, err := v.hashFrom(ctx, h, offset, size)
		offset += n
		if err == nil && offset == size {
			return hex.EncodeToString(h.Sum(nil)), offset, nil
		}
		if err == nil {
			err = fmt.Errorf("object ended at %d of %d bytes", offset, size)
		}
		if errors.Is(err, ErrObjectNotFound) {
			return "", offset, err
		}
		lastErr = err
		log.Printf("verify: read attempt %d/%d stopped at %d/%d bytes: %v", attempt, v.readAttempts, offset, size, err)
		select {
		case <-ctx.Done():
			return "", offset, ctx.Err()
		case <-time.After(v.retryDelay):
		}
	}
	return "", offset, lastErr
}

func (v *IntegrityVerifier) hashFrom(ctx context.Context, h hash.Hash, offset, size int64) (int64, error) {
	var (
		body io.ReadCloser
		err  error
	)
	if offset == 0 {
		body, err = v.storage.GetObject(ctx, v.cfg.ObjectKey)
	} else {
		body, err = v.storage.GetObjectRange(ctx, v.cfg.ObjectKey, offset, size-offset)
	}
	if err != nil {
		return 0, err
	}
	defer func() { _ = body.Close() }()
	return io.Copy(h, body)
}

func (v *IntegrityVerifier) startHeartbeat(ctx context.Context) func() {
	if v.heartbeat <= 0 {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(v.heartbeat)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				_ = v.report(ctx, verifyPayload{Status: "running"})
			}
		}
	}()
	return func() { close(done) }
}

type verifyPayload struct {
	Status string `json:"status"`
	Sha256 string `json:"sha256,omitempty"`
	Error  string `json:"error,omitempty"`
}

func (v *IntegrityVerifier) reportWithRetry(ctx context.Context, p verifyPayload) error {
	err := v.report(ctx, p)
	for _, delay := range v.reportDelays {
		if err == nil {
			return nil
		}
		log.Printf("warning: verification status %q not delivered, retrying in %s: %v", p.Status, delay, err)
		select {
		case <-ctx.Done():
			return err
		case <-time.After(delay):
		}
		err = v.report(ctx, p)
	}
	return err
}

func (v *IntegrityVerifier) report(ctx context.Context, p verifyPayload) error {
	if v.cfg.WorkerAPIURL == "" {
		return nil
	}
	payload, _ := json.Marshal(p)
	url := strings.TrimRight(v.cfg.WorkerAPIURL, "/") + fmt.Sprintf("/api/internal/jobs/%s/status", v.cfg.JobID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if v.cfg.InternalAPISecret != "" {
		req.Header.Set("Authorization", "Bearer "+v.cfg.InternalAPISecret)
	}
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("worker API returned %d: %s", resp.StatusCode, string(body))
	}
	return nil
}
