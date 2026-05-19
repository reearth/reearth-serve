package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/davidbyttow/govips/v2/vips"
)

// Thumbnail sizes mirror worker/thumbnail/sizes.ts. Keep these in sync.
type thumbSpec struct {
	Name     string
	LongEdge int
	Quality  int
}

// Ordered largest → smallest so we can build a pyramid (each step downsamples
// from the previous result rather than from the original).
var thumbSpecsLargestFirst = []thumbSpec{
	{Name: "lg", LongEdge: 1280, Quality: 85},
	{Name: "md", LongEdge: 512, Quality: 85},
	{Name: "sm", LongEdge: 128, Quality: 80},
	{Name: "xs", LongEdge: 64, Quality: 80},
}

type generateRequest struct {
	AssetID   string `json:"assetId"`
	VersionID string `json:"versionId,omitempty"`
	SourceKey string `json:"sourceKey"`
	// ContentType is informational; libvips sniffs the actual format.
	ContentType string `json:"contentType,omitempty"`
}

func main() {
	vips.Startup(&vips.Config{
		// ConcurrencyLevel=0 lets libvips pick from CPU count. On a 1/2 vCPU
		// instance that resolves to 1 worker thread, which is what we want —
		// extra threads would just contend on the half-share.
		ConcurrencyLevel: 0,
	})
	defer vips.Shutdown()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/generate", handleGenerate)

	addr := ":8080"
	log.Printf("thumbnail container listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func handleGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req generateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}
	if req.AssetID == "" || req.SourceKey == "" {
		http.Error(w, "missing assetId or sourceKey", http.StatusBadRequest)
		return
	}

	if err := generate(r.Context(), req); err != nil {
		log.Printf("generate failed for %s: %v", req.SourceKey, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func generate(ctx context.Context, req generateRequest) error {
	s3c, bucket, err := newS3Client(ctx)
	if err != nil {
		return fmt.Errorf("init s3 client: %w", err)
	}

	src, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(req.SourceKey),
	})
	if err != nil {
		return fmt.Errorf("get source: %w", err)
	}
	defer src.Body.Close()

	img, err := vips.NewImageFromReader(src.Body)
	if err != nil {
		return fmt.Errorf("decode source: %w", err)
	}
	defer img.Close()

	srcLongEdge := img.Width()
	if img.Height() > srcLongEdge {
		srcLongEdge = img.Height()
	}

	// Sequential pyramid: lg → md → sm → xs. Each step resizes the previous
	// (smaller) result. Sizes larger than the source are skipped, but xs is
	// always emitted (at source dimensions if necessary) so consumers always
	// get at least one thumbnail.
	produced := 0
	for _, spec := range thumbSpecsLargestFirst {
		if spec.LongEdge >= srcLongEdge && spec.Name != "xs" {
			continue
		}

		currentLongEdge := img.Width()
		if img.Height() > currentLongEdge {
			currentLongEdge = img.Height()
		}
		scale := float64(spec.LongEdge) / float64(currentLongEdge)
		if scale > 1 {
			scale = 1
		}
		if scale < 1 {
			if err := img.Resize(scale, vips.KernelLanczos3); err != nil {
				return fmt.Errorf("resize %s: %w", spec.Name, err)
			}
		}

		out, _, err := img.ExportWebp(&vips.WebpExportParams{
			Quality:         spec.Quality,
			StripMetadata:   true,
			ReductionEffort: 4,
		})
		if err != nil {
			return fmt.Errorf("encode %s: %w", spec.Name, err)
		}

		key := thumbKey(req.AssetID, req.VersionID, spec.Name)
		if _, err := s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket:        aws.String(bucket),
			Key:           aws.String(key),
			Body:          bytes.NewReader(out),
			ContentType:   aws.String("image/webp"),
			ContentLength: aws.Int64(int64(len(out))),
		}); err != nil {
			return fmt.Errorf("put %s: %w", spec.Name, err)
		}
		produced++
	}
	log.Printf("generated %d thumbnail(s) for asset=%s version=%s", produced, req.AssetID, req.VersionID)
	return nil
}

func thumbKey(assetID, versionID, sizeName string) string {
	if versionID != "" {
		return fmt.Sprintf("assets/%s/v/%s/_thumbs/%s.webp", assetID, versionID, sizeName)
	}
	return fmt.Sprintf("assets/%s/_thumbs/%s.webp", assetID, sizeName)
}

func newS3Client(ctx context.Context) (*s3.Client, string, error) {
	endpoint := os.Getenv("R2_ENDPOINT")
	accessKey := os.Getenv("R2_ACCESS_KEY_ID")
	secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")
	bucket := os.Getenv("R2_BUCKET")
	if endpoint == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil, "", fmt.Errorf("R2 credentials not configured")
	}

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("auto"),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		return nil, "", err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = strings.Contains(endpoint, "r2.cloudflarestorage.com")
		o.BaseEndpoint = aws.String(endpoint)
	})
	return client, bucket, nil
}
