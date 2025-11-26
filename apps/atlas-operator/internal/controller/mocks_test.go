package controller

import (
	"context"
	"sync"

	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/argocd"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// MockDatabaseClient is a mock implementation of database.Client for testing.
type MockDatabaseClient struct {
	Users            []database.User
	HealthErr        error
	GetUsersErr      error
	PoolUserCount    int
	CountPoolErr     error
	CreatePoolErr    error
	CreatedPoolUsers []string
}

func (m *MockDatabaseClient) GetUsers(ctx context.Context, limit int, afterID string) ([]database.User, error) {
	if m.GetUsersErr != nil {
		return nil, m.GetUsersErr
	}
	// Simulate cursor-based pagination
	startIdx := 0
	if afterID != "" {
		for i, u := range m.Users {
			if u.ID == afterID {
				startIdx = i + 1
				break
			}
		}
	}
	if startIdx >= len(m.Users) {
		return []database.User{}, nil
	}
	endIdx := startIdx + limit
	if endIdx > len(m.Users) {
		endIdx = len(m.Users)
	}
	return m.Users[startIdx:endIdx], nil
}

func (m *MockDatabaseClient) CountPoolUsers(ctx context.Context) (int, error) {
	if m.CountPoolErr != nil {
		return 0, m.CountPoolErr
	}
	return m.PoolUserCount, nil
}

func (m *MockDatabaseClient) CreatePoolUser(ctx context.Context) (string, error) {
	if m.CreatePoolErr != nil {
		return "", m.CreatePoolErr
	}
	userID := "pool-user-" + string(rune('a'+len(m.CreatedPoolUsers)))
	m.CreatedPoolUsers = append(m.CreatedPoolUsers, userID)
	m.PoolUserCount++
	return userID, nil
}

func (m *MockDatabaseClient) Health() error {
	return m.HealthErr
}

func (m *MockDatabaseClient) Close() error {
	return nil
}

// MockArgoCDManager is a mock implementation of argocd.Manager for testing.
type MockArgoCDManager struct {
	mu           sync.Mutex
	Applications []*unstructured.Unstructured
	CreatedApps  []string // Track created user IDs
	DeletedApps  []string // Track deleted user IDs
	ListErr      error
	CreateErr    error
	DeleteErr    error
	GetErr       error
}

func (m *MockArgoCDManager) CreateApplication(ctx context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.CreateErr != nil {
		return m.CreateErr
	}

	// Track the creation
	m.CreatedApps = append(m.CreatedApps, userID)

	// Add to applications list
	app := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      argocd.UserIDToAppName(userID),
				"namespace": "argocd",
				"labels": map[string]interface{}{
					"managed-by": "atlas-operator",
					"user-id":    userID,
				},
			},
		},
	}
	m.Applications = append(m.Applications, app)

	return nil
}

func (m *MockArgoCDManager) DeleteApplication(ctx context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.DeleteErr != nil {
		return m.DeleteErr
	}

	// Track the deletion
	m.DeletedApps = append(m.DeletedApps, userID)

	// Remove from applications list
	for i, app := range m.Applications {
		labels := app.GetLabels()
		if labels["user-id"] == userID {
			m.Applications = append(m.Applications[:i], m.Applications[i+1:]...)
			break
		}
	}

	return nil
}

func (m *MockArgoCDManager) GetApplication(ctx context.Context, name string) (*unstructured.Unstructured, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.GetErr != nil {
		return nil, m.GetErr
	}

	for _, app := range m.Applications {
		if app.GetName() == name {
			return app, nil
		}
	}

	return nil, nil
}

func (m *MockArgoCDManager) ListApplications(ctx context.Context) ([]*unstructured.Unstructured, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.ListErr != nil {
		return nil, m.ListErr
	}
	return m.Applications, nil
}
