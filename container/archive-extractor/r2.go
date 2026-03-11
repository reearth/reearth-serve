package main

import (
	"context"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Verify R2Client implements both ObjectStorage and ReaderAtStorage.
var (
	_ ObjectStorage   = (*R2Client)(nil)
	_ ReaderAtStorage = (*R2Client)(nil)
)

// R2Client wraps the S3-compatible API for Cloudflare R2.
type R2Client struct {
	client *s3.Client
	bucket string
}

// R2Config holds the configuration for connecting to R2.
type R2Config struct {
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
}

// NewR2Client creates a new R2 client using S3-compatible API.
func NewR2Client(ctx context.Context, cfg R2Config) (*R2Client, error) {
	awsCfg, err := config.LoadDefaultConfig(ctx,
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			cfg.AccessKeyID, cfg.SecretAccessKey, "",
		)),
		config.WithRegion("auto"),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	endpoint := cfg.Endpoint
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = &endpoint
		o.UsePathStyle = true
	})

	return &R2Client{client: client, bucket: cfg.Bucket}, nil
}

func (r *R2Client) GetObject(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := r.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &r.bucket,
		Key:    &key,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get object %s: %w", key, err)
	}
	return out.Body, nil
}

func (r *R2Client) GetObjectRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	rangeHeader := fmt.Sprintf("bytes=%d-%d", offset, offset+length-1)
	out, err := r.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &r.bucket,
		Key:    &key,
		Range:  &rangeHeader,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get object range %s [%d-%d]: %w", key, offset, offset+length-1, err)
	}
	return out.Body, nil
}

func (r *R2Client) HeadObject(ctx context.Context, key string) (int64, error) {
	out, err := r.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: &r.bucket,
		Key:    &key,
	})
	if err != nil {
		return 0, fmt.Errorf("failed to head object %s: %w", key, err)
	}
	if out.ContentLength == nil {
		return 0, fmt.Errorf("content length is nil for %s", key)
	}
	return *out.ContentLength, nil
}

func (r *R2Client) PutObject(ctx context.Context, key string, body io.Reader, contentType string, opts *PutOptions) error {
	input := &s3.PutObjectInput{
		Bucket:      &r.bucket,
		Key:         &key,
		Body:        body,
		ContentType: &contentType,
	}
	if opts != nil && opts.ContentEncoding != "" {
		input.ContentEncoding = &opts.ContentEncoding
	}
	if _, err := r.client.PutObject(ctx, input); err != nil {
		return fmt.Errorf("failed to put object %s: %w", key, err)
	}
	return nil
}

func (r *R2Client) DeleteObject(ctx context.Context, key string) error {
	if _, err := r.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: &r.bucket,
		Key:    &key,
	}); err != nil {
		return fmt.Errorf("failed to delete object %s: %w", key, err)
	}
	return nil
}

// NewReaderAt creates an io.ReaderAt for the given key using Range requests.
func (r *R2Client) NewReaderAt(ctx context.Context, key string) (io.ReaderAt, error) {
	return &R2ReaderAt{
		client: r.client,
		bucket: r.bucket,
		key:    key,
		ctx:    ctx,
	}, nil
}
