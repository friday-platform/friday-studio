package service

import (
	"context"
	"errors"
	"io"

	"cloud.google.com/go/storage"
	"github.com/google/uuid"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

var (
	ErrObjectNotExist      = errors.New("object does not exist")
	ErrObjectAlreadyExists = errors.New("object already exists")
)

type StorageClient struct {
	client *storage.Client
	bucket string
}

func NewStorageClient(ctx context.Context, bucket, serviceAccountKeyFile string) (*StorageClient, error) {
	var client *storage.Client
	var err error

	if serviceAccountKeyFile != "" {
		client, err = storage.NewClient(ctx, option.WithCredentialsFile(serviceAccountKeyFile))
	} else {
		client, err = storage.NewClient(ctx)
	}

	if err != nil {
		return nil, err
	}

	return &StorageClient{
		client: client,
		bucket: bucket,
	}, nil
}

func (s *StorageClient) Upload(ctx context.Context, id uuid.UUID, content []byte) error {
	objectPath := ObjectPath(id)
	obj := s.client.Bucket(s.bucket).Object(objectPath)

	// Use DoesNotExist precondition to prevent overwriting existing objects
	obj = obj.If(storage.Conditions{DoesNotExist: true})

	writer := obj.NewWriter(ctx)
	writer.ContentType = "text/html; charset=utf-8"

	if _, err := writer.Write(content); err != nil {
		_ = writer.Close()
		return err
	}

	// GCS validates preconditions on Close (412 = object already exists)
	if err := writer.Close(); err != nil {
		var gErr *googleapi.Error
		if errors.As(err, &gErr) && gErr.Code == 412 {
			return ErrObjectAlreadyExists
		}
		return err
	}

	return nil
}

func (s *StorageClient) Download(ctx context.Context, id uuid.UUID) ([]byte, error) {
	objectPath := ObjectPath(id)
	obj := s.client.Bucket(s.bucket).Object(objectPath)

	reader, err := obj.NewReader(ctx)
	if err != nil {
		if errors.Is(err, storage.ErrObjectNotExist) {
			return nil, ErrObjectNotExist
		}
		return nil, err
	}
	defer func() { _ = reader.Close() }()

	return io.ReadAll(reader)
}

func (s *StorageClient) Close() error {
	return s.client.Close()
}
