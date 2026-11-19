// Command signfixture prints a V4 signed URL made by the Go storage client
// Re:Earth CMS uses, with the options CMS passes (its reearth-x-* query
// parameters renamed), as the JSON fixture that
// core/compat/gcs/signed-url.test.ts verifies. Rerun it to refresh the fixture:
//
//	go -C e2e/compat-gcs run ./signfixture > core/compat/gcs/signed-url.fixture.json
package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/option"
)

const (
	apiHost     = "storage.example.test:8443"
	clientEmail = "fixture0000000001@storage.example.test"
	bucket      = "media"
	key         = "assets/ab/cdef0123/my file (1)+データ.geojson"
)

type fixture struct {
	URL             string            `json:"url"`
	APIHost         string            `json:"apiHost"`
	ClientEmail     string            `json:"clientEmail"`
	PublicJwk       map[string]string `json:"publicJwk"`
	Bucket          string            `json:"bucket"`
	Key             string            `json:"key"`
	ContentType     string            `json:"contentType"`
	ContentEncoding string            `json:"contentEncoding"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return err
	}
	keyFile, err := json.Marshal(map[string]string{
		"type":           "service_account",
		"project_id":     "fixture",
		"private_key_id": "fixture0000000001",
		"private_key":    string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email":   clientEmail,
		"client_id":      "fixture0000000001",
		"token_uri":      "https://" + apiHost + "/token",
	})
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "signfixture-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	keyPath := filepath.Join(dir, "key.json")
	if err := os.WriteFile(keyPath, keyFile, 0o600); err != nil {
		return err
	}

	ctx := context.Background()
	client, err := storage.NewClient(ctx,
		option.WithEndpoint("http://"+apiHost+"/storage/v1/"),
		option.WithCredentialsFile(keyPath),
	)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	signed, err := client.Bucket(bucket).SignedURL(key, &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      http.MethodPut,
		Expires:     time.Now().Add(15 * time.Minute),
		ContentType: "application/geo+json",
		QueryParameters: map[string][]string{
			"x-app-workspace": {"ws 1"},
			"x-app-project":   {"p1"},
			"x-app-public":    {"true"},
		},
		Headers: []string{"Content-Encoding: gzip"},
	})
	if err != nil {
		return err
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(fixture{
		URL:         signed,
		APIHost:     apiHost,
		ClientEmail: clientEmail,
		PublicJwk: map[string]string{
			"kty": "RSA",
			"n":   base64.RawURLEncoding.EncodeToString(priv.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(priv.E)).Bytes()),
		},
		Bucket:          bucket,
		Key:             key,
		ContentType:     "application/geo+json",
		ContentEncoding: "gzip",
	})
}
