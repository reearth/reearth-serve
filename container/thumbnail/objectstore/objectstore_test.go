package objectstore

import (
	"strings"
	"testing"
)

func envFrom(vars map[string]string) Getenv {
	return func(name string) string { return vars[name] }
}

func r2PathStyle(endpoint string) bool {
	return strings.Contains(endpoint, "r2.cloudflarestorage.com")
}

func TestLoadNewNames(t *testing.T) {
	cfg, deprecated, err := Load(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://acct.r2.cloudflarestorage.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
	}), r2PathStyle)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(deprecated) != 0 {
		t.Errorf("expected no deprecations, got %v", deprecated)
	}
	if cfg.AccessKeyID != "key" || cfg.SecretAccessKey != "secret" || cfg.Bucket != "bucket" {
		t.Errorf("unexpected config: %+v", cfg)
	}
	if cfg.Region != DefaultRegion {
		t.Errorf("region = %q, want %q", cfg.Region, DefaultRegion)
	}
	if !cfg.PathStyle {
		t.Error("an R2 endpoint should default to path-style addressing")
	}
}

func TestLoadLegacyNames(t *testing.T) {
	cfg, deprecated, err := Load(envFrom(map[string]string{
		"R2_ENDPOINT":          "https://acct.r2.cloudflarestorage.com",
		"R2_ACCESS_KEY_ID":     "key",
		"R2_SECRET_ACCESS_KEY": "secret",
		"R2_BUCKET":            "bucket",
	}), r2PathStyle)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Bucket != "bucket" {
		t.Errorf("bucket = %q", cfg.Bucket)
	}
	want := []string{"R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"}
	if len(deprecated) != len(want) {
		t.Fatalf("deprecated = %v, want %v", deprecated, want)
	}
	for i, name := range want {
		if deprecated[i] != name {
			t.Errorf("deprecated[%d] = %q, want %q", i, deprecated[i], name)
		}
	}
	if msg := DeprecationMessage(deprecated); !strings.Contains(msg, "DEPRECATED") {
		t.Errorf("unexpected deprecation message: %q", msg)
	}
	if msg := DeprecationMessage(nil); msg != "" {
		t.Errorf("expected an empty message, got %q", msg)
	}
}

func TestLoadNewNamesWin(t *testing.T) {
	cfg, deprecated, err := Load(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":      "https://new.example.com",
		"R2_ENDPOINT":                "https://old.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID": "key",
		"R2_SECRET_ACCESS_KEY":       "secret",
		"OBJECT_STORE_BUCKET":        "bucket",
	}), r2PathStyle)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Endpoint != "https://new.example.com" {
		t.Errorf("endpoint = %q, want the new name to win", cfg.Endpoint)
	}
	if len(deprecated) != 1 || deprecated[0] != "R2_SECRET_ACCESS_KEY" {
		t.Errorf("deprecated = %v", deprecated)
	}
	if cfg.PathStyle {
		t.Error("a non-R2 endpoint should default to virtual-host addressing")
	}
}

func TestLoadRegionAndPathStyleOverrides(t *testing.T) {
	cfg, _, err := Load(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://minio.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
		"OBJECT_STORE_REGION":            "us-east-1",
		"OBJECT_STORE_PATH_STYLE":        "true",
	}), r2PathStyle)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Region != "us-east-1" {
		t.Errorf("region = %q", cfg.Region)
	}
	if !cfg.PathStyle {
		t.Error("OBJECT_STORE_PATH_STYLE=true should win over the default")
	}
}

func TestLoadInvalidPathStyle(t *testing.T) {
	_, _, err := Load(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://minio.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
		"OBJECT_STORE_PATH_STYLE":        "maybe",
	}), r2PathStyle)
	if err == nil || !strings.Contains(err.Error(), EnvPathStyle) {
		t.Fatalf("expected an OBJECT_STORE_PATH_STYLE error, got %v", err)
	}
}

func TestLoadMissingReportsNewName(t *testing.T) {
	_, _, err := Load(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT": "https://minio.example.com",
	}), r2PathStyle)
	if err == nil || !strings.Contains(err.Error(), EnvAccessKeyID) {
		t.Fatalf("error should name the new variable, got %v", err)
	}
}
