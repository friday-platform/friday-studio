package service

import (
	"context"
	"fmt"
	"io"

	"cloud.google.com/go/auth/credentials"
	"cloud.google.com/go/storage"
	"github.com/google/uuid"
	"google.golang.org/api/option"
)

type StorageClient struct {
	client *storage.Client
	bucket *storage.BucketHandle
}

func NewStorageClient(ctx context.Context, bucketName, serviceAccountKeyFile string) (*StorageClient, error) {
	var client *storage.Client
	var err error

	if serviceAccountKeyFile != "" {
		creds, credErr := credentials.DetectDefault(&credentials.DetectOptions{
			Scopes:          []string{"https://www.googleapis.com/auth/cloud-platform"},
			CredentialsFile: serviceAccountKeyFile,
		})
		if credErr != nil {
			return nil, fmt.Errorf("failed to detect credentials: %w", credErr)
		}
		client, err = storage.NewClient(ctx, option.WithAuthCredentials(creds))
	} else {
		client, err = storage.NewClient(ctx)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to create storage client: %w", err)
	}

	return &StorageClient{
		client: client,
		bucket: client.Bucket(bucketName),
	}, nil
}

// StoragePath generates path from UUID: 550e8400/e29b/550e8400-e29b-41d4-a716-446655440000.
func StoragePath(id uuid.UUID) string {
	s := id.String()
	return fmt.Sprintf("%s/%s/%s", s[:8], s[9:13], s)
}

func (sc *StorageClient) Upload(ctx context.Context, id uuid.UUID, data io.Reader) error {
	path := StoragePath(id)
	obj := sc.bucket.Object(path)

	w := obj.NewWriter(ctx)
	if _, err := io.Copy(w, data); err != nil {
		_ = w.Close()
		return fmt.Errorf("failed to upload: %w", err)
	}

	if err := w.Close(); err != nil {
		return fmt.Errorf("failed to close writer: %w", err)
	}

	return nil
}

func (sc *StorageClient) Download(ctx context.Context, id uuid.UUID) (io.ReadCloser, error) {
	path := StoragePath(id)
	obj := sc.bucket.Object(path)

	r, err := obj.NewReader(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to download: %w", err)
	}

	return r, nil
}

func (sc *StorageClient) Close() error {
	if sc.client != nil {
		return sc.client.Close()
	}
	return nil
}
