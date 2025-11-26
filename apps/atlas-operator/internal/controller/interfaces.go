package controller

import (
	"context"

	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// DatabaseClient defines the interface for database operations.
type DatabaseClient interface {
	GetUsers(ctx context.Context, limit int, afterID string) ([]database.User, error)
	CountPoolUsers(ctx context.Context) (int, error)
	CreatePoolUser(ctx context.Context) (string, error)
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
