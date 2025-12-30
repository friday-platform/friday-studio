package controller

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/config"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestNewReconciler(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	mockDB := &MockDatabaseClient{}
	mockArgoCD := &MockArgoCDManager{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	if r == nil {
		t.Fatal("expected non-nil reconciler")
	}
	if r.Config != cfg {
		t.Error("config not set correctly")
	}
	if r.Logger != logger {
		t.Error("logger not set correctly")
	}
	if r.stopCh == nil {
		t.Error("stopCh not initialized")
	}
}

func TestStop(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 100 * time.Millisecond,
	}

	r := NewReconciler(Deps{Config: cfg, Logger: logger})

	// Verify stopCh is open initially
	select {
	case <-r.stopCh:
		t.Error("stopCh closed before Stop() called")
	default:
		// Success - channel is open
	}

	// Stop the reconciler
	r.Stop()

	// Verify the stop channel is closed
	select {
	case <-r.stopCh:
		// Success - channel is closed
	case <-time.After(1 * time.Second):
		t.Error("stopCh not closed after Stop()")
	}
}

func TestReconcile_CreateNewApplications(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	// Setup: 2 users in database, 0 existing applications
	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
			{ID: "user-2"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("Reconcile failed: %v", err)
	}

	// Verify 2 applications were created
	if len(mockArgoCD.CreatedApps) != 2 {
		t.Errorf("Expected 2 applications created, got %d", len(mockArgoCD.CreatedApps))
	}

	// Verify correct user IDs
	createdMap := make(map[string]bool)
	for _, userID := range mockArgoCD.CreatedApps {
		createdMap[userID] = true
	}

	if !createdMap["user-1"] || !createdMap["user-2"] {
		t.Error("Expected user-1 and user-2 to be created")
	}
}

func TestReconcile_DeleteRemovedApplications(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	// Setup: 1 user in database, 2 existing applications
	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{
			{
				Object: map[string]interface{}{
					"apiVersion": "argoproj.io/v1alpha1",
					"kind":       "Application",
					"metadata": map[string]interface{}{
						"name":      "atlas-user-user-1",
						"namespace": "argocd",
						"labels": map[string]interface{}{
							"managed-by": "atlas-operator",
							"user-id":    "user-1",
						},
					},
				},
			},
			{
				Object: map[string]interface{}{
					"apiVersion": "argoproj.io/v1alpha1",
					"kind":       "Application",
					"metadata": map[string]interface{}{
						"name":      "atlas-user-user-2",
						"namespace": "argocd",
						"labels": map[string]interface{}{
							"managed-by": "atlas-operator",
							"user-id":    "user-2",
						},
					},
				},
			},
		},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("Reconcile failed: %v", err)
	}

	// Verify 1 application was deleted (user-2)
	if len(mockArgoCD.DeletedApps) != 1 {
		t.Errorf("Expected 1 application deleted, got %d", len(mockArgoCD.DeletedApps))
	}

	if mockArgoCD.DeletedApps[0] != "user-2" {
		t.Errorf("Expected user-2 to be deleted, got %s", mockArgoCD.DeletedApps[0])
	}

	// Verify no new applications were created
	if len(mockArgoCD.CreatedApps) != 0 {
		t.Errorf("Expected 0 applications created, got %d", len(mockArgoCD.CreatedApps))
	}
}

func TestReconcile_MixedOperations(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	// Setup: 3 users in DB, 2 existing apps
	// user-1: exists in both (no action)
	// user-2: only in apps (delete)
	// user-3: only in DB (create)
	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
			{ID: "user-3"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{
			{
				Object: map[string]interface{}{
					"apiVersion": "argoproj.io/v1alpha1",
					"kind":       "Application",
					"metadata": map[string]interface{}{
						"name":      "atlas-user-user-1",
						"namespace": "argocd",
						"labels": map[string]interface{}{
							"managed-by": "atlas-operator",
							"user-id":    "user-1",
						},
					},
				},
			},
			{
				Object: map[string]interface{}{
					"apiVersion": "argoproj.io/v1alpha1",
					"kind":       "Application",
					"metadata": map[string]interface{}{
						"name":      "atlas-user-user-2",
						"namespace": "argocd",
						"labels": map[string]interface{}{
							"managed-by": "atlas-operator",
							"user-id":    "user-2",
						},
					},
				},
			},
		},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("Reconcile failed: %v", err)
	}

	// Verify 1 application created (user-3)
	if len(mockArgoCD.CreatedApps) != 1 {
		t.Errorf("Expected 1 application created, got %d", len(mockArgoCD.CreatedApps))
	}
	if mockArgoCD.CreatedApps[0] != "user-3" {
		t.Errorf("Expected user-3 to be created, got %s", mockArgoCD.CreatedApps[0])
	}

	// Verify 1 application deleted (user-2)
	if len(mockArgoCD.DeletedApps) != 1 {
		t.Errorf("Expected 1 application deleted, got %d", len(mockArgoCD.DeletedApps))
	}
	if mockArgoCD.DeletedApps[0] != "user-2" {
		t.Errorf("Expected user-2 to be deleted, got %s", mockArgoCD.DeletedApps[0])
	}
}

func TestReconcile_DatabaseError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	mockDB := &MockDatabaseClient{
		GetUsersErr: fmt.Errorf("database connection failed"),
	}
	mockArgoCD := &MockArgoCDManager{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err == nil {
		t.Error("Expected error when database fails")
	}
	if err != nil && err.Error() != "failed to get users from database: database connection failed" {
		t.Errorf("Unexpected error message: %v", err)
	}
}

func TestReconcile_ArgoCDListError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		ListErr: fmt.Errorf("kubernetes API error"),
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err == nil {
		t.Error("Expected error when ArgoCD list fails")
	}
}

func TestReconcile_ContinuesOnPartialFailure(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	// Setup: 2 users to create, but creation will fail for both
	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
			{ID: "user-2"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
		CreateErr:    fmt.Errorf("creation failed"),
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	// Should not return error (logs errors but continues)
	if err != nil {
		t.Errorf("Expected no error when individual creates fail, got: %v", err)
	}
}

func TestReconcile_AppWithoutUserIDLabel(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{
			{
				Object: map[string]interface{}{
					"apiVersion": "argoproj.io/v1alpha1",
					"kind":       "Application",
					"metadata": map[string]interface{}{
						"name":      "atlas-user-invalid",
						"namespace": "argocd",
						"labels": map[string]interface{}{
							"managed-by": "atlas-operator",
							// Missing user-id label
						},
					},
				},
			},
		},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	// Should succeed - invalid apps are skipped with warning
	if err != nil {
		t.Errorf("Expected no error when app has invalid labels, got: %v", err)
	}

	// No deletions should occur
	if len(mockArgoCD.DeletedApps) != 0 {
		t.Error("Expected no deletions for invalid app")
	}
}

func TestHealth_AllHealthy(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{}

	mockDB := &MockDatabaseClient{
		HealthErr: nil,
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	err := r.Health()
	if err != nil {
		t.Errorf("Expected no error when all healthy, got: %v", err)
	}
}

func TestHealth_DatabaseUnhealthy(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{}

	mockDB := &MockDatabaseClient{
		HealthErr: fmt.Errorf("connection refused"),
	}
	mockArgoCD := &MockArgoCDManager{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	err := r.Health()
	if err == nil {
		t.Error("Expected error when database is unhealthy")
	}
}

func TestHealth_ArgoCDUnhealthy(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{}

	mockDB := &MockDatabaseClient{
		HealthErr: nil,
	}
	mockArgoCD := &MockArgoCDManager{
		ListErr: fmt.Errorf("kubernetes API unavailable"),
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	err := r.Health()
	if err == nil {
		t.Error("Expected error when ArgoCD is unhealthy")
	}
}

func TestHealth_NilDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{}

	r := NewReconciler(Deps{Config: cfg, Logger: logger})

	err := r.Health()
	if err == nil {
		t.Error("Expected error when dependencies are nil")
	}
}

func TestStart_ContextCancellation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 50 * time.Millisecond,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx, cancel := context.WithCancel(context.Background())

	// Start reconciler in background
	errCh := make(chan error, 1)
	go func() {
		errCh <- r.Start(ctx)
	}()

	// Let it run for a bit
	time.Sleep(150 * time.Millisecond)

	// Cancel context
	cancel()

	// Wait for Start to return
	select {
	case err := <-errCh:
		// Context cancellation returns context.Canceled error, which is expected
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Errorf("Expected context.Canceled error on context cancellation, got: %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Error("Start() did not return after context cancellation")
	}
}

func TestStart_StopChannel(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 50 * time.Millisecond,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()

	// Start reconciler in background
	errCh := make(chan error, 1)
	go func() {
		errCh <- r.Start(ctx)
	}()

	// Let it run for a bit
	time.Sleep(150 * time.Millisecond)

	// Stop reconciler
	r.Stop()

	// Wait for Start to return
	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("Expected no error on stop, got: %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Error("Start() did not return after Stop()")
	}
}

func TestStart_PeriodicReconciliation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 50 * time.Millisecond,
	}

	reconcileCount := 0
	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start reconciler in background
	go func() {
		_ = r.Start(ctx)
	}()

	// Wait for multiple reconciliation cycles
	time.Sleep(200 * time.Millisecond)

	// Check that reconciliation happened multiple times
	// (application should have been created at least once)
	mockArgoCD.mu.Lock()
	reconcileCount = len(mockArgoCD.CreatedApps)
	mockArgoCD.mu.Unlock()

	if reconcileCount == 0 {
		t.Error("Expected at least one reconciliation cycle to occur")
	}

	// Note: Due to timing, we might see the user created multiple times
	// (once per cycle if create is idempotent fails), but at least once
	t.Logf("Reconciliation occurred %d times", reconcileCount)

	cancel()
	time.Sleep(100 * time.Millisecond)
}

func TestReconcile_WithLiteLLM_CreatesVirtualKeys(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
		LiteLLMDefaultBudget:   200.0,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
			{ID: "user-2"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}
	mockLiteLLM := &MockLiteLLMClient{}
	mockCypher := &MockCypherClient{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, LiteLLM: mockLiteLLM, Cypher: mockCypher, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Check that virtual keys were created for both users
	if len(mockLiteLLM.CreatedKeys) != 2 {
		t.Errorf("expected 2 keys created, got %d", len(mockLiteLLM.CreatedKeys))
	}
	if _, ok := mockLiteLLM.CreatedKeys["user-1"]; !ok {
		t.Error("expected key for user-1")
	}
	if _, ok := mockLiteLLM.CreatedKeys["user-2"]; !ok {
		t.Error("expected key for user-2")
	}

	// Check that keys were encrypted via Cypher
	if len(mockCypher.EncryptedData) != 2 {
		t.Errorf("expected 2 users encrypted, got %d", len(mockCypher.EncryptedData))
	}

	// Check that keys were stored in database
	if len(mockDB.VirtualKeys) != 2 {
		t.Errorf("expected 2 keys stored, got %d", len(mockDB.VirtualKeys))
	}
}

func TestReconcile_WithLiteLLM_SkipsExistingKeys(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
		LiteLLMDefaultBudget:   200.0,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
			{ID: "user-2"},
		},
		VirtualKeys: map[string][]byte{
			"user-1": []byte("existing-key"), // user-1 already has a key
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}
	mockLiteLLM := &MockLiteLLMClient{}
	mockCypher := &MockCypherClient{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, LiteLLM: mockLiteLLM, Cypher: mockCypher, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Only user-2 should get a new key
	if len(mockLiteLLM.CreatedKeys) != 1 {
		t.Errorf("expected 1 key created, got %d", len(mockLiteLLM.CreatedKeys))
	}
	if _, ok := mockLiteLLM.CreatedKeys["user-2"]; !ok {
		t.Error("expected key for user-2")
	}
	if _, ok := mockLiteLLM.CreatedKeys["user-1"]; ok {
		t.Error("should not create key for user-1 (already exists)")
	}
}

func TestReconcile_WithLiteLLM_DeletesKeysForRemovedUsers(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
		LiteLLMDefaultBudget:   200.0,
	}

	// No users in database
	mockDB := &MockDatabaseClient{
		Users: []database.User{},
	}
	// But user-orphan has an existing app
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{
			{
				Object: map[string]interface{}{
					"apiVersion": "argoproj.io/v1alpha1",
					"kind":       "Application",
					"metadata": map[string]interface{}{
						"name":      "atlas-user-orphan",
						"namespace": "argocd",
						"labels": map[string]interface{}{
							"managed-by": "atlas-operator",
							"user-id":    "user-orphan",
						},
					},
				},
			},
		},
	}
	mockLiteLLM := &MockLiteLLMClient{}
	mockCypher := &MockCypherClient{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, LiteLLM: mockLiteLLM, Cypher: mockCypher, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should delete the virtual key for orphaned user
	if len(mockLiteLLM.DeletedUserIDs) != 1 {
		t.Errorf("expected 1 key deleted, got %d", len(mockLiteLLM.DeletedUserIDs))
	}
	if mockLiteLLM.DeletedUserIDs[0] != "user-orphan" {
		t.Errorf("expected deleted user-orphan, got %s", mockLiteLLM.DeletedUserIDs[0])
	}

	// Should also delete the app
	if len(mockArgoCD.DeletedApps) != 1 {
		t.Errorf("expected 1 app deleted, got %d", len(mockArgoCD.DeletedApps))
	}
}

func TestReconcile_WithLiteLLM_ContinuesOnKeyCreationError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
		LiteLLMDefaultBudget:   200.0,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
			{ID: "user-2"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}
	mockLiteLLM := &MockLiteLLMClient{
		CreateKeyErr: fmt.Errorf("LiteLLM unavailable"),
	}
	mockCypher := &MockCypherClient{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, LiteLLM: mockLiteLLM, Cypher: mockCypher, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	// Reconciliation should succeed even if key creation fails
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Apps should still be created
	if len(mockArgoCD.CreatedApps) != 2 {
		t.Errorf("expected 2 apps created, got %d", len(mockArgoCD.CreatedApps))
	}
}

func TestReconcile_WithLiteLLM_ContinuesOnEncryptError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
		LiteLLMDefaultBudget:   200.0,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}
	mockLiteLLM := &MockLiteLLMClient{}
	mockCypher := &MockCypherClient{
		EncryptErr: fmt.Errorf("Cypher unavailable"),
	}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, LiteLLM: mockLiteLLM, Cypher: mockCypher, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	// Reconciliation should succeed even if encryption fails
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Key was created in LiteLLM
	if len(mockLiteLLM.CreatedKeys) != 1 {
		t.Errorf("expected 1 key created in LiteLLM, got %d", len(mockLiteLLM.CreatedKeys))
	}

	// Key should be rolled back (deleted) due to encryption failure
	if len(mockLiteLLM.DeletedUserIDs) != 1 || mockLiteLLM.DeletedUserIDs[0] != "user-1" {
		t.Errorf("expected key to be rolled back for user-1, got deletions: %v", mockLiteLLM.DeletedUserIDs)
	}

	// Key should NOT be stored in database (encryption failed)
	if len(mockDB.VirtualKeys) != 0 {
		t.Errorf("expected 0 keys stored, got %d", len(mockDB.VirtualKeys))
	}
}

func TestReconcile_WithoutLiteLLM_SkipsKeyOperations(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-1"},
		},
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}

	// No LiteLLM or Cypher clients (nil)
	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// App should be created
	if len(mockArgoCD.CreatedApps) != 1 {
		t.Errorf("expected 1 app created, got %d", len(mockArgoCD.CreatedApps))
	}

	// No keys should be created (LiteLLM disabled)
	if len(mockDB.VirtualKeys) != 0 {
		t.Errorf("expected 0 keys, got %d", len(mockDB.VirtualKeys))
	}
}

func TestReconcile_WithLiteLLM_RecreatesOrphanedKey(t *testing.T) {
	// This test verifies that when a key exists in LiteLLM but not in our database
	// (orphaned key), the reconciler deletes the orphaned key and creates a new one.
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
		LiteLLMDefaultBudget:   200.0,
	}

	mockDB := &MockDatabaseClient{
		Users: []database.User{
			{ID: "user-orphan"}, // This user has an orphaned key in LiteLLM
			{ID: "user-normal"}, // This user has no key anywhere
		},
		// Note: no virtual keys in database - user-orphan has orphaned key in LiteLLM only
	}
	mockArgoCD := &MockArgoCDManager{
		Applications: []*unstructured.Unstructured{},
	}
	mockLiteLLM := &MockLiteLLMClient{
		OrphanedKeyUserIDs: map[string]bool{
			"user-orphan": true, // Key exists in LiteLLM but not in our database
		},
	}
	mockCypher := &MockCypherClient{}

	r := NewReconciler(Deps{DB: mockDB, ArgoCD: mockArgoCD, LiteLLM: mockLiteLLM, Cypher: mockCypher, Config: cfg, Logger: logger})

	ctx := context.Background()
	err := r.Reconcile(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The orphaned key should be deleted first
	if len(mockLiteLLM.DeletedUserIDs) != 1 {
		t.Errorf("expected 1 key deleted, got %d", len(mockLiteLLM.DeletedUserIDs))
	}
	if mockLiteLLM.DeletedUserIDs[0] != "user-orphan" {
		t.Errorf("expected deleted user-orphan, got %s", mockLiteLLM.DeletedUserIDs[0])
	}

	// Both users should have keys created (orphan was recreated, normal was created)
	if len(mockLiteLLM.CreatedKeys) != 2 {
		t.Errorf("expected 2 keys created, got %d", len(mockLiteLLM.CreatedKeys))
	}
	if _, ok := mockLiteLLM.CreatedKeys["user-orphan"]; !ok {
		t.Error("expected key for user-orphan to be recreated")
	}
	if _, ok := mockLiteLLM.CreatedKeys["user-normal"]; !ok {
		t.Error("expected key for user-normal")
	}

	// Both keys should be encrypted via Cypher
	if len(mockCypher.EncryptedData) != 2 {
		t.Errorf("expected 2 users encrypted, got %d", len(mockCypher.EncryptedData))
	}

	// Both keys should be stored in database
	if len(mockDB.VirtualKeys) != 2 {
		t.Errorf("expected 2 keys stored, got %d", len(mockDB.VirtualKeys))
	}
}
