package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sort"
	"sync"
)

// MemoryStorage implements ObjectStorage for testing.
// It stores all objects in memory and is safe for concurrent use.
type MemoryStorage struct {
	mu      sync.RWMutex
	objects map[string]memObject
}

type memObject struct {
	data        []byte
	contentType string
}

// NewMemoryStorage creates a new MemoryStorage.
func NewMemoryStorage() *MemoryStorage {
	return &MemoryStorage{objects: make(map[string]memObject)}
}

func (m *MemoryStorage) GetObject(_ context.Context, key string) (io.ReadCloser, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	obj, ok := m.objects[key]
	if !ok {
		return nil, fmt.Errorf("get object %s: %w", key, ErrObjectNotFound)
	}
	return io.NopCloser(bytes.NewReader(obj.data)), nil
}

func (m *MemoryStorage) GetObjectRange(_ context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	obj, ok := m.objects[key]
	if !ok {
		return nil, fmt.Errorf("get object range %s: %w", key, ErrObjectNotFound)
	}
	if offset >= int64(len(obj.data)) {
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	end := offset + length
	if end > int64(len(obj.data)) {
		end = int64(len(obj.data))
	}
	return io.NopCloser(bytes.NewReader(obj.data[offset:end])), nil
}

func (m *MemoryStorage) HeadObject(_ context.Context, key string) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	obj, ok := m.objects[key]
	if !ok {
		return 0, fmt.Errorf("head object %s: %w", key, ErrObjectNotFound)
	}
	return int64(len(obj.data)), nil
}

func (m *MemoryStorage) PutObject(_ context.Context, key string, body io.Reader, _ int64, contentType string, _ *PutOptions) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return fmt.Errorf("failed to read body: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = memObject{data: data, contentType: contentType}
	return nil
}

func (m *MemoryStorage) DeleteObject(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	return nil
}

// Keys returns all stored keys sorted alphabetically.
func (m *MemoryStorage) Keys() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	keys := make([]string, 0, len(m.objects))
	for k := range m.objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// GetData returns the raw bytes stored for a key.
func (m *MemoryStorage) GetData(key string) ([]byte, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	obj, ok := m.objects[key]
	if !ok {
		return nil, false
	}
	return obj.data, true
}
