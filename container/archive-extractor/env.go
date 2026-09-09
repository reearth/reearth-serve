package main

import (
	"fmt"
	"strconv"
)

// Object store configuration is provider-neutral (ADR-012): the container only
// needs S3-compatible credentials, so the variables are named OBJECT_STORE_*.
// The deprecated R2_* names are still accepted for one release so a worker that
// has not been redeployed yet keeps working.
const (
	envEndpoint     = "OBJECT_STORE_ENDPOINT"
	envAccessKeyID  = "OBJECT_STORE_ACCESS_KEY_ID"
	envSecretKey    = "OBJECT_STORE_SECRET_ACCESS_KEY"
	envBucket       = "OBJECT_STORE_BUCKET"
	envRegion       = "OBJECT_STORE_REGION"
	envPathStyle    = "OBJECT_STORE_PATH_STYLE"
	defaultRegion   = "auto"
	legacyEndpoint  = "R2_ENDPOINT"
	legacyAccessKey = "R2_ACCESS_KEY_ID"
	legacySecretKey = "R2_SECRET_ACCESS_KEY"
	legacyBucket    = "R2_BUCKET"
)

// objectStoreConfig is the S3-compatible connection configuration read from the
// environment.
type objectStoreConfig struct {
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	Region          string
	PathStyle       bool
}

// getenv is the environment lookup used by the loaders. Tests substitute a map.
type getenv func(string) string

// lookupObjectStoreVar returns the value of name, falling back to the
// deprecated legacy name. The second result is the name that actually supplied
// the value, or "" when neither was set.
func lookupObjectStoreVar(env getenv, name, legacy string) (string, string) {
	if v := env(name); v != "" {
		return v, name
	}
	if v := env(legacy); v != "" {
		return v, legacy
	}
	return "", ""
}

// loadObjectStoreConfig reads the object store configuration. pathStyleDefault
// is used when OBJECT_STORE_PATH_STYLE is unset. The returned slice lists the
// deprecated variable names that were used, so the caller can log them.
func loadObjectStoreConfig(env getenv, pathStyleDefault bool) (objectStoreConfig, []string, error) {
	cfg := objectStoreConfig{
		Region:    defaultRegion,
		PathStyle: pathStyleDefault,
	}

	var deprecated []string
	for _, f := range []struct {
		dst          *string
		name, legacy string
	}{
		{&cfg.Endpoint, envEndpoint, legacyEndpoint},
		{&cfg.AccessKeyID, envAccessKeyID, legacyAccessKey},
		{&cfg.SecretAccessKey, envSecretKey, legacySecretKey},
		{&cfg.Bucket, envBucket, legacyBucket},
	} {
		value, source := lookupObjectStoreVar(env, f.name, f.legacy)
		if value == "" {
			return objectStoreConfig{}, nil, fmt.Errorf("required environment variable %s is not set", f.name)
		}
		if source == f.legacy {
			deprecated = append(deprecated, f.legacy)
		}
		*f.dst = value
	}

	if v := env(envRegion); v != "" {
		cfg.Region = v
	}
	if v := env(envPathStyle); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return objectStoreConfig{}, nil, fmt.Errorf("invalid %s: %q is not a boolean", envPathStyle, v)
		}
		cfg.PathStyle = b
	}

	return cfg, deprecated, nil
}

// deprecationMessage describes the deprecated variables that were used, or ""
// when there were none.
func deprecationMessage(deprecated []string) string {
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
