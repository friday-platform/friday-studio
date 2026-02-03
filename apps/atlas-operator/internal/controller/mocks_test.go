package controller

import (
	"context"
	"fmt"
	"sync"

	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/argocd"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/litellm"
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
	// Virtual key mocks
	VirtualKeys         map[string][]byte
	HasVirtualKeyErr    error
	InsertKeyErr        error
	DeleteVirtualKeyErr error
	DeletedVirtualKeys  []string
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

func (m *MockDatabaseClient) HasVirtualKey(ctx context.Context, userID string) (bool, error) {
	if m.HasVirtualKeyErr != nil {
		return false, m.HasVirtualKeyErr
	}
	if m.VirtualKeys == nil {
		return false, nil
	}
	_, exists := m.VirtualKeys[userID]
	return exists, nil
}

func (m *MockDatabaseClient) InsertVirtualKey(ctx context.Context, userID string, ciphertext []byte) error {
	if m.InsertKeyErr != nil {
		return m.InsertKeyErr
	}
	if m.VirtualKeys == nil {
		m.VirtualKeys = make(map[string][]byte)
	}
	m.VirtualKeys[userID] = ciphertext
	return nil
}

func (m *MockDatabaseClient) DeleteVirtualKey(ctx context.Context, userID string) error {
	if m.DeleteVirtualKeyErr != nil {
		return m.DeleteVirtualKeyErr
	}
	delete(m.VirtualKeys, userID)
	m.DeletedVirtualKeys = append(m.DeletedVirtualKeys, userID)
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

// MockLiteLLMClient is a mock implementation of LiteLLMClient for testing.
type MockLiteLLMClient struct {
	CreatedKeys        map[string]string // userID -> key
	DeletedUserIDs     []string
	CreateKeyErr       error
	DeleteKeyErr       error
	HasKeyErr          error
	CreateKeyResult    *litellm.CreateVirtualKeyResponse
	OrphanedKeyUserIDs map[string]bool // userIDs that have orphaned keys in LiteLLM
	// LiteLLMKeys tracks which users have keys in litellm (for HasKey)
	LiteLLMKeys map[string]bool
}

func (m *MockLiteLLMClient) CreateVirtualKey(ctx context.Context, req litellm.CreateVirtualKeyRequest) (*litellm.CreateVirtualKeyResponse, error) {
	// Simulate orphaned key scenario: key exists in LiteLLM but not in our database
	if m.OrphanedKeyUserIDs != nil && m.OrphanedKeyUserIDs[req.UserID] {
		return nil, fmt.Errorf("unexpected status 400: Key with alias 'atlas-%s' already exists", req.UserID)
	}
	if m.CreateKeyErr != nil {
		return nil, m.CreateKeyErr
	}
	if m.CreatedKeys == nil {
		m.CreatedKeys = make(map[string]string)
	}
	key := "sk-test-key-" + req.UserID
	m.CreatedKeys[req.UserID] = key

	if m.CreateKeyResult != nil {
		return m.CreateKeyResult, nil
	}
	return &litellm.CreateVirtualKeyResponse{
		Key:    key,
		UserID: req.UserID,
	}, nil
}

func (m *MockLiteLLMClient) DeleteVirtualKeyByUserID(ctx context.Context, userID string) error {
	if m.DeleteKeyErr != nil {
		return m.DeleteKeyErr
	}
	m.DeletedUserIDs = append(m.DeletedUserIDs, userID)
	// Clear the orphaned key status when deleted
	if m.OrphanedKeyUserIDs != nil {
		delete(m.OrphanedKeyUserIDs, userID)
	}
	// Clear from LiteLLMKeys tracking
	if m.LiteLLMKeys != nil {
		delete(m.LiteLLMKeys, userID)
	}
	return nil
}

func (m *MockLiteLLMClient) HasKey(ctx context.Context, userID string) (bool, error) {
	if m.HasKeyErr != nil {
		return false, m.HasKeyErr
	}
	if m.LiteLLMKeys != nil {
		return m.LiteLLMKeys[userID], nil
	}
	// Also check OrphanedKeyUserIDs for backward compat with existing tests
	if m.OrphanedKeyUserIDs != nil {
		return m.OrphanedKeyUserIDs[userID], nil
	}
	return false, nil
}

// MockCypherClient is a mock implementation of CypherClient for testing.
type MockCypherClient struct {
	EncryptedData map[string][][]byte // userID -> ciphertexts
	EncryptErr    error
}

func (m *MockCypherClient) Encrypt(ctx context.Context, userID string, plaintext []string) ([][]byte, error) {
	if m.EncryptErr != nil {
		return nil, m.EncryptErr
	}
	if m.EncryptedData == nil {
		m.EncryptedData = make(map[string][][]byte)
	}
	// Generate fake ciphertexts
	ciphertexts := make([][]byte, len(plaintext))
	for i, pt := range plaintext {
		ciphertexts[i] = []byte("encrypted-" + pt)
	}
	m.EncryptedData[userID] = ciphertexts
	return ciphertexts, nil
}
