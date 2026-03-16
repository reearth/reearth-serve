package main

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
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
		// Disable CRC32 checksum — R2 does not support AWS SDK v2's default checksum validation
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
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

func (r *R2Client) PutObject(ctx context.Context, key string, body io.Reader, contentLength int64, contentType string, opts *PutOptions) error {
	if contentLength < 0 {
		return r.putObjectMultipart(ctx, key, body, contentType, opts)
	}

	input := &s3.PutObjectInput{
		Bucket:        &r.bucket,
		Key:           &key,
		Body:          body,
		ContentType:   &contentType,
		ContentLength: &contentLength,
	}
	if opts != nil && opts.ContentEncoding != "" {
		input.ContentEncoding = &opts.ContentEncoding
	}
	if _, err := r.client.PutObject(ctx, input); err != nil {
		return fmt.Errorf("failed to put object %s: %w", key, err)
	}
	return nil
}

const multipartPartSize = 10 * 1024 * 1024 // 10MB per part

func (r *R2Client) putObjectMultipart(ctx context.Context, key string, body io.Reader, contentType string, opts *PutOptions) error {
	createInput := &s3.CreateMultipartUploadInput{
		Bucket:      &r.bucket,
		Key:         &key,
		ContentType: &contentType,
	}
	if opts != nil && opts.ContentEncoding != "" {
		createInput.ContentEncoding = &opts.ContentEncoding
	}
	createOut, err := r.client.CreateMultipartUpload(ctx, createInput)
	if err != nil {
		return fmt.Errorf("failed to create multipart upload for %s: %w", key, err)
	}
	uploadID := createOut.UploadId

	var completedParts []types.CompletedPart
	partNumber := int32(1)
	buf := make([]byte, multipartPartSize)

	for {
		n, readErr := io.ReadFull(body, buf)
		if n > 0 {
			partLen := int64(n)
			uploadOut, err := r.client.UploadPart(ctx, &s3.UploadPartInput{
				Bucket:        &r.bucket,
				Key:           &key,
				UploadId:      uploadID,
				PartNumber:    &partNumber,
				Body:          bytes.NewReader(buf[:n]),
				ContentLength: &partLen,
			})
			if err != nil {
				_ = r.abortMultipartUpload(ctx, key, uploadID)
				return fmt.Errorf("failed to upload part %d for %s: %w", partNumber, key, err)
			}
			completedParts = append(completedParts, types.CompletedPart{
				PartNumber: &partNumber,
				ETag:       uploadOut.ETag,
			})
			partNumber++
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			_ = r.abortMultipartUpload(ctx, key, uploadID)
			return fmt.Errorf("failed to read body for %s: %w", key, readErr)
		}
	}

	if len(completedParts) == 0 {
		// Empty body — abort multipart and do a regular zero-length PUT
		_ = r.abortMultipartUpload(ctx, key, uploadID)
		zero := int64(0)
		_, err := r.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:        &r.bucket,
			Key:           &key,
			Body:          bytes.NewReader(nil),
			ContentType:   &contentType,
			ContentLength: &zero,
		})
		return err
	}

	_, err = r.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:   &r.bucket,
		Key:      &key,
		UploadId: uploadID,
		MultipartUpload: &types.CompletedMultipartUpload{
			Parts: completedParts,
		},
	})
	if err != nil {
		return fmt.Errorf("failed to complete multipart upload for %s: %w", key, err)
	}
	return nil
}

func (r *R2Client) abortMultipartUpload(ctx context.Context, key string, uploadID *string) error {
	_, err := r.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   &r.bucket,
		Key:      &key,
		UploadId: uploadID,
	})
	return err
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
