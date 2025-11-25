package controller

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/tempestteam/atlas-operator/pkg/config"
	"github.com/tempestteam/atlas-operator/pkg/database"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestNewReconciler(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}

	mockDB := &MockDatabaseClient{}
	mockArgoCD := &MockArgoCDManager{}

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

	if r == nil {
		t.Fatal("expected non-nil reconciler")
	}
	if r.config != cfg {
		t.Error("config not set correctly")
	}
	if r.logger != logger {
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

	r := NewReconciler(nil, nil, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

	err := r.Health()
	if err == nil {
		t.Error("Expected error when ArgoCD is unhealthy")
	}
}

func TestHealth_NilDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{}

	r := NewReconciler(nil, nil, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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

	r := NewReconciler(mockDB, mockArgoCD, cfg, logger)

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
