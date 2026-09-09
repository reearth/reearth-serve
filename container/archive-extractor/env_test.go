package main

import (
	"strings"
	"testing"
)

func envFrom(vars map[string]string) getenv {
	return func(name string) string { return vars[name] }
}

func requiredExtractionVars() map[string]string {
	return map[string]string{
		"ASSET_ID":         "asset-1",
		"ARCHIVE_KEY":      "assets/asset-1/_archive/a.zip",
		"ARCHIVE_FILENAME": "a.zip",
		"ARCHIVE_FORMAT":   "zip",
	}
}

func TestLoadObjectStoreConfigNewNames(t *testing.T) {
	cfg, deprecated, err := loadObjectStoreConfig(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
	}), true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(deprecated) != 0 {
		t.Errorf("expected no deprecations, got %v", deprecated)
	}
	if cfg.Endpoint != "https://example.com" || cfg.AccessKeyID != "key" ||
		cfg.SecretAccessKey != "secret" || cfg.Bucket != "bucket" {
		t.Errorf("unexpected config: %+v", cfg)
	}
	if cfg.Region != "auto" {
		t.Errorf("expected default region auto, got %q", cfg.Region)
	}
	if !cfg.PathStyle {
		t.Error("expected path style to keep the supplied default")
	}
}

func TestLoadObjectStoreConfigLegacyNames(t *testing.T) {
	cfg, deprecated, err := loadObjectStoreConfig(envFrom(map[string]string{
		"R2_ENDPOINT":          "https://r2.example.com",
		"R2_ACCESS_KEY_ID":     "key",
		"R2_SECRET_ACCESS_KEY": "secret",
		"R2_BUCKET":            "bucket",
	}), true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Endpoint != "https://r2.example.com" || cfg.Bucket != "bucket" {
		t.Errorf("unexpected config: %+v", cfg)
	}
	want := []string{"R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"}
	if len(deprecated) != len(want) {
		t.Fatalf("expected %v, got %v", want, deprecated)
	}
	for i, name := range want {
		if deprecated[i] != name {
			t.Errorf("deprecated[%d] = %q, want %q", i, deprecated[i], name)
		}
	}
	msg := deprecationMessage(deprecated)
	if !strings.Contains(msg, "DEPRECATED") || !strings.Contains(msg, "R2_ENDPOINT") {
		t.Errorf("unexpected deprecation message: %q", msg)
	}
}

func TestLoadObjectStoreConfigNewNamesWin(t *testing.T) {
	cfg, deprecated, err := loadObjectStoreConfig(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://new.example.com",
		"R2_ENDPOINT":                    "https://old.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"R2_BUCKET":                      "bucket",
	}), true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Endpoint != "https://new.example.com" {
		t.Errorf("expected the new name to win, got %q", cfg.Endpoint)
	}
	if len(deprecated) != 1 || deprecated[0] != "R2_BUCKET" {
		t.Errorf("expected only R2_BUCKET reported, got %v", deprecated)
	}
}

func TestLoadObjectStoreConfigRegionAndPathStyle(t *testing.T) {
	cfg, _, err := loadObjectStoreConfig(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://s3.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
		"OBJECT_STORE_REGION":            "ap-northeast-1",
		"OBJECT_STORE_PATH_STYLE":        "false",
	}), true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Region != "ap-northeast-1" {
		t.Errorf("region = %q", cfg.Region)
	}
	if cfg.PathStyle {
		t.Error("expected path style to be disabled")
	}
}

func TestLoadObjectStoreConfigInvalidPathStyle(t *testing.T) {
	_, _, err := loadObjectStoreConfig(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":          "https://s3.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID":     "key",
		"OBJECT_STORE_SECRET_ACCESS_KEY": "secret",
		"OBJECT_STORE_BUCKET":            "bucket",
		"OBJECT_STORE_PATH_STYLE":        "yes please",
	}), true)
	if err == nil {
		t.Fatal("expected an error for a non-boolean OBJECT_STORE_PATH_STYLE")
	}
	if !strings.Contains(err.Error(), "OBJECT_STORE_PATH_STYLE") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestLoadObjectStoreConfigMissingReportsNewName(t *testing.T) {
	_, _, err := loadObjectStoreConfig(envFrom(map[string]string{
		"OBJECT_STORE_ENDPOINT":      "https://s3.example.com",
		"OBJECT_STORE_ACCESS_KEY_ID": "key",
	}), true)
	if err == nil {
		t.Fatal("expected an error for the missing secret key")
	}
	if !strings.Contains(err.Error(), "OBJECT_STORE_SECRET_ACCESS_KEY") {
		t.Errorf("error should name the new variable, got: %v", err)
	}
}

func TestLoadConfigDefaultsToPathStyle(t *testing.T) {
	vars := requiredExtractionVars()
	vars["OBJECT_STORE_ENDPOINT"] = "https://s3.example.com"
	vars["OBJECT_STORE_ACCESS_KEY_ID"] = "key"
	vars["OBJECT_STORE_SECRET_ACCESS_KEY"] = "secret"
	vars["OBJECT_STORE_BUCKET"] = "bucket"

	cfg, err := loadConfig(envFrom(vars))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.ObjectStore.PathStyle {
		t.Error("extractor should default to path-style addressing")
	}
	if cfg.ObjectStore.Region != "auto" {
		t.Errorf("region = %q, want auto", cfg.ObjectStore.Region)
	}
	if cfg.MaxConcurrency != 48 || cfg.CheckpointEvery != 100 {
		t.Errorf("unexpected tuning defaults: %d/%d", cfg.MaxConcurrency, cfg.CheckpointEvery)
	}
}

func TestLoadConfigMissingExtractionVar(t *testing.T) {
	vars := map[string]string{
		"R2_ENDPOINT":          "https://r2.example.com",
		"R2_ACCESS_KEY_ID":     "key",
		"R2_SECRET_ACCESS_KEY": "secret",
		"R2_BUCKET":            "bucket",
		"ASSET_ID":             "asset-1",
	}
	if _, err := loadConfig(envFrom(vars)); err == nil {
		t.Fatal("expected an error for the missing ARCHIVE_KEY")
	}
}
