package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// JobCheckpoint tracks extraction progress for resume support.
type JobCheckpoint struct {
	Phase                 string       `json:"phase"`
	LastProcessedIndex    int          `json:"lastProcessedIndex"`
	ProcessedCount        int          `json:"processedCount"`
	ProcessedBytes        int64        `json:"processedBytes"`
	TotalEntries          int          `json:"totalEntries"`
	ManifestChunksWritten int          `json:"manifestChunksWritten"`
	RootPrefix            string       `json:"rootPrefix"`
	Errors                []EntryError `json:"errors,omitempty"`
}

// EntryError records an error for a specific archive entry.
type EntryError struct {
	Index int    `json:"index"`
	Path  string `json:"path"`
	Error string `json:"error"`
}

// CheckpointManager reads and writes checkpoints to object storage.
type CheckpointManager struct {
	storage ObjectStorage
	key     string
}

// NewCheckpointManager creates a new CheckpointManager.
func NewCheckpointManager(storage ObjectStorage, assetID string) *CheckpointManager {
	return &CheckpointManager{
		storage: storage,
		key:     fmt.Sprintf("assets/%s/_archive/_checkpoint.json", assetID),
	}
}

// Load reads the checkpoint from storage. Returns nil if not found.
func (cm *CheckpointManager) Load(ctx context.Context) (*JobCheckpoint, error) {
	body, err := cm.storage.GetObject(ctx, cm.key)
	if err != nil {
		return nil, nil
	}
	defer func() { _ = body.Close() }()

	data, err := io.ReadAll(body)
	if err != nil {
		return nil, fmt.Errorf("failed to read checkpoint: %w", err)
	}

	var cp JobCheckpoint
	if err := json.Unmarshal(data, &cp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal checkpoint: %w", err)
	}
	return &cp, nil
}

// Save writes the checkpoint to storage.
func (cm *CheckpointManager) Save(ctx context.Context, cp *JobCheckpoint) error {
	data, err := json.Marshal(cp)
	if err != nil {
		return fmt.Errorf("failed to marshal checkpoint: %w", err)
	}

	if err := cm.storage.PutObject(ctx, cm.key, bytes.NewReader(data), "application/json", nil); err != nil {
		return fmt.Errorf("failed to save checkpoint: %w", err)
	}
	return nil
}

// Delete removes the checkpoint from storage.
func (cm *CheckpointManager) Delete(ctx context.Context) error {
	return cm.storage.DeleteObject(ctx, cm.key)
}
