// Package objectstore reads the S3-compatible object store configuration from
// the environment.
//
// The configuration is provider-neutral (ADR-012): the container only needs
// S3-compatible credentials, so the variables are named OBJECT_STORE_*. The
// deprecated R2_* names are still accepted for one release so a worker that has
// not been redeployed yet keeps working.
//
// It lives in its own package so it can be tested without libvips, which the
// main package needs through cgo.
package objectstore

import (
	"fmt"
	"strconv"
)

const (
	EnvEndpoint     = "OBJECT_STORE_ENDPOINT"
	EnvAccessKeyID  = "OBJECT_STORE_ACCESS_KEY_ID"
	EnvSecretKey    = "OBJECT_STORE_SECRET_ACCESS_KEY"
	EnvBucket       = "OBJECT_STORE_BUCKET"
	EnvRegion       = "OBJECT_STORE_REGION"
	EnvPathStyle    = "OBJECT_STORE_PATH_STYLE"
	DefaultRegion   = "auto"
	legacyEndpoint  = "R2_ENDPOINT"
	legacyAccessKey = "R2_ACCESS_KEY_ID"
	legacySecretKey = "R2_SECRET_ACCESS_KEY"
	legacyBucket    = "R2_BUCKET"
)

// Config is the S3-compatible connection configuration.
type Config struct {
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	// Region is the signing region; defaults to "auto" (what R2 expects).
	Region string
	// PathStyle addresses buckets as <endpoint>/<bucket> instead of using a
	// virtual host. R2 and MinIO want this on.
	PathStyle bool
}

// Getenv is the environment lookup used by Load. Tests substitute a map.
type Getenv func(string) string

func lookup(env Getenv, name, legacy string) (string, string) {
	if v := env(name); v != "" {
		return v, name
	}
	if v := env(legacy); v != "" {
		return v, legacy
	}
	return "", ""
}

// Load reads the configuration. pathStyleDefault decides path-style addressing
// when OBJECT_STORE_PATH_STYLE is unset; it is a function of the endpoint, so
// it is passed in lazily. The returned slice lists the deprecated variable
// names that were used, so the caller can log them.
func Load(env Getenv, pathStyleDefault func(endpoint string) bool) (Config, []string, error) {
	cfg := Config{Region: DefaultRegion}

	var deprecated []string
	for _, f := range []struct {
		dst          *string
		name, legacy string
	}{
		{&cfg.Endpoint, EnvEndpoint, legacyEndpoint},
		{&cfg.AccessKeyID, EnvAccessKeyID, legacyAccessKey},
		{&cfg.SecretAccessKey, EnvSecretKey, legacySecretKey},
		{&cfg.Bucket, EnvBucket, legacyBucket},
	} {
		value, source := lookup(env, f.name, f.legacy)
		if value == "" {
			return Config{}, nil, fmt.Errorf("required environment variable %s is not set", f.name)
		}
		if source == f.legacy {
			deprecated = append(deprecated, f.legacy)
		}
		*f.dst = value
	}

	if pathStyleDefault != nil {
		cfg.PathStyle = pathStyleDefault(cfg.Endpoint)
	}
	if v := env(EnvRegion); v != "" {
		cfg.Region = v
	}
	if v := env(EnvPathStyle); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, nil, fmt.Errorf("invalid %s: %q is not a boolean", EnvPathStyle, v)
		}
		cfg.PathStyle = b
	}

	return cfg, deprecated, nil
}

// DeprecationMessage describes the deprecated variables that were used, or ""
// when there were none.
func DeprecationMessage(deprecated []string) string {
	if len(deprecated) == 0 {
		return ""
	}
	msg := "DEPRECATED: object store configuration read from"
	for i, name := range deprecated {
		if i > 0 {
			msg += ","
		}
		msg += " " + name
	}
	return msg + "; use the OBJECT_STORE_* names instead (the R2_* names will be removed in a future release)"
}
