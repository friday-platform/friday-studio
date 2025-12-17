package controller

import (
	"context"

	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/litellm"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// DatabaseClient defines the interface for database operations.
type DatabaseClient interface {
	GetUsers(ctx context.Context, limit int, afterID string) ([]database.User, error)
	CountPoolUsers(ctx context.Context) (int, error)
	CreatePoolUser(ctx context.Context) (string, error)
	HasVirtualKey(ctx context.Context, userID string) (bool, error)
	InsertVirtualKey(ctx context.Context, userID string, ciphertext []byte) error
	Health() error
	Close() error
}

// ArgoCDManager defines the interface for ArgoCD operations.
type ArgoCDManager interface {
	CreateApplication(ctx context.Context, userID string) error
	DeleteApplication(ctx context.Context, userID string) error
	GetApplication(ctx context.Context, name string) (*unstructured.Unstructured, error)
	ListApplications(ctx context.Context) ([]*unstructured.Unstructured, error)
}

// PoolManager defines the interface for pool operations.
type PoolManager interface {
	Replenish(ctx context.Context) (int, error)
}

// LiteLLMClient defines the interface for LiteLLM API operations.
type LiteLLMClient interface {
	CreateVirtualKey(ctx context.Context, req litellm.CreateVirtualKeyRequest) (*litellm.CreateVirtualKeyResponse, error)
	DeleteVirtualKeyByUserID(ctx context.Context, userID string) error
}

// CypherClient defines the interface for Cypher encryption operations.
type CypherClient interface {
	Encrypt(ctx context.Context, userID string, plaintext []string) ([][]byte, error)
}
