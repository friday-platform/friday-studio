package controller

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/argocd"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/config"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/litellm"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	// usersPageSize is the number of users to fetch per database query.
	usersPageSize = 100
)

// Reconciler handles the main reconciliation loop.
type Reconciler struct {
	dbClient      DatabaseClient
	argoCDManager ArgoCDManager
	poolManager   PoolManager
	litellmClient LiteLLMClient
	cypherClient  CypherClient
	config        *config.Config
	logger        *slog.Logger
	stopCh        chan struct{}
}

// NewReconciler creates a new reconciler.
func NewReconciler(
	dbClient DatabaseClient,
	argoCDManager ArgoCDManager,
	poolManager PoolManager,
	litellmClient LiteLLMClient,
	cypherClient CypherClient,
	config *config.Config,
	logger *slog.Logger,
) *Reconciler {
	return &Reconciler{
		dbClient:      dbClient,
		argoCDManager: argoCDManager,
		poolManager:   poolManager,
		litellmClient: litellmClient,
		cypherClient:  cypherClient,
		config:        config,
		logger:        logger,
		stopCh:        make(chan struct{}),
	}
}

// Start begins the reconciliation loop.
func (r *Reconciler) Start(ctx context.Context) error {
	r.logger.Info("Starting reconciliation loop",
		"interval", r.config.ReconciliationInterval,
	)

	// Run initial reconciliation
	if err := r.Reconcile(ctx); err != nil {
		r.logger.Error("Initial reconciliation failed", "error", err)
	}

	// Start the periodic reconciliation
	ticker := time.NewTicker(r.config.ReconciliationInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			r.logger.Info("Stopping reconciliation loop")
			return ctx.Err()
		case <-r.stopCh:
			r.logger.Info("Reconciliation loop stopped")
			return nil
		case <-ticker.C:
			start := time.Now()
			if err := r.Reconcile(ctx); err != nil {
				r.logger.Error("Reconciliation failed",
					"error", err,
					"duration", time.Since(start),
				)
			} else {
				r.logger.Debug("Reconciliation completed",
					"duration", time.Since(start),
				)
			}
		}
	}
}

// Stop signals the reconciliation loop to stop.
func (r *Reconciler) Stop() {
	close(r.stopCh)
}

// Reconcile performs a single reconciliation.
func (r *Reconciler) Reconcile(ctx context.Context) error {
	r.logger.Debug("Starting reconciliation")

	// Get current users from database using cursor-based pagination
	var dbUsers []database.User
	afterID := ""
	for {
		page, err := r.dbClient.GetUsers(ctx, usersPageSize, afterID)
		if err != nil {
			return fmt.Errorf("failed to get users from database: %w", err)
		}
		dbUsers = append(dbUsers, page...)
		if len(page) < usersPageSize {
			break
		}
		afterID = page[len(page)-1].ID
	}

	// Get existing ArgoCD Applications
	apps, err := r.argoCDManager.ListApplications(ctx)
	if err != nil {
		return fmt.Errorf("failed to list applications: %w", err)
	}

	// Create maps for efficient lookup
	dbUserMap := make(map[string]*database.User)
	for i := range dbUsers {
		dbUserMap[dbUsers[i].ID] = &dbUsers[i]
	}

	appUserMap := make(map[string]*unstructured.Unstructured)
	for _, app := range apps {
		userID, err := argocd.GetUserIDFromApplication(app)
		if err != nil {
			r.logger.Warn("Failed to get user ID from application",
				"error", err,
				"app", app.GetName(),
			)
			continue
		}
		appUserMap[userID] = app
	}

	// Create applications for new users
	created := 0
	keysCreated := 0
	for userID := range dbUserMap {
		if _, exists := appUserMap[userID]; !exists {
			r.logger.Info("Creating application for new user",
				"user_id", userID,
			)
			if err := r.argoCDManager.CreateApplication(ctx, userID); err != nil {
				r.logger.Error("Failed to create application",
					"error", err,
					"user_id", userID,
				)
				// Continue with other users
			} else {
				created++
			}
		}

		// Create LiteLLM virtual key if enabled and user doesn't have one
		if r.litellmClient != nil && r.cypherClient != nil {
			keyCreated, err := r.ensureVirtualKey(ctx, userID)
			if err != nil {
				r.logger.Error("Failed to ensure virtual key",
					"error", err,
					"user_id", userID,
				)
				// Continue with other users - key can be created in next reconciliation
			} else if keyCreated {
				keysCreated++
			}
		}
	}

	// Delete applications and revoke keys for removed users
	deleted := 0
	keysDeleted := 0
	for userID := range appUserMap {
		if _, exists := dbUserMap[userID]; !exists {
			r.logger.Info("Cleaning up removed user",
				"user_id", userID,
			)

			// Revoke LiteLLM virtual key first (if LiteLLM is enabled)
			if r.litellmClient != nil {
				if err := r.litellmClient.DeleteVirtualKeyByUserID(ctx, userID); err != nil {
					r.logger.Error("Failed to revoke virtual key",
						"error", err,
						"user_id", userID,
					)
					// Continue - key may not exist or LiteLLM may be unavailable
				} else {
					keysDeleted++
				}
			}

			// Delete ArgoCD application
			if err := r.argoCDManager.DeleteApplication(ctx, userID); err != nil {
				r.logger.Error("Failed to delete application",
					"error", err,
					"user_id", userID,
				)
				// Continue with other users
			} else {
				deleted++
			}
		}
	}

	r.logger.Info("Reconciliation completed",
		"db_users", len(dbUsers),
		"existing_apps", len(apps),
		"apps_created", created,
		"apps_deleted", deleted,
		"keys_created", keysCreated,
		"keys_deleted", keysDeleted,
	)

	// Replenish pool if enabled
	if r.poolManager != nil {
		if _, err := r.poolManager.Replenish(ctx); err != nil {
			r.logger.Error("Failed to replenish pool", "error", err)
			// Don't fail reconciliation for pool errors
		}
	}

	return nil
}

// ensureVirtualKey creates a LiteLLM virtual key for a user if they don't already have one.
// Returns (true, nil) if a new key was created, (false, nil) if user already has a key,
// or (false, error) if key creation failed.
func (r *Reconciler) ensureVirtualKey(ctx context.Context, userID string) (bool, error) {
	// Check if user already has a virtual key
	hasKey, err := r.dbClient.HasVirtualKey(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("check virtual key: %w", err)
	}
	if hasKey {
		return false, nil // Already has a key, nothing to do
	}

	// Create virtual key via LiteLLM
	req := litellm.CreateVirtualKeyRequest{
		UserID:         userID,
		KeyAlias:       litellm.KeyAliasForUser(userID),
		MaxBudget:      litellm.Float64Ptr(r.config.LiteLLMDefaultBudget),
		BudgetDuration: r.config.LiteLLMBudgetDuration,
	}

	resp, err := r.litellmClient.CreateVirtualKey(ctx, req)
	if err != nil {
		return false, fmt.Errorf("create virtual key: %w", err)
	}

	// Encrypt the key via Cypher
	ciphertexts, err := r.cypherClient.Encrypt(ctx, userID, []string{resp.Key})
	if err != nil {
		// Rollback: delete the key from LiteLLM since we can't store it
		if delErr := r.litellmClient.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			r.logger.Error("Failed to rollback virtual key after encryption failure",
				"user_id", userID,
				"error", delErr,
			)
		}
		return false, fmt.Errorf("encrypt virtual key: %w", err)
	}

	if len(ciphertexts) != 1 {
		// Rollback: unexpected response from Cypher
		if delErr := r.litellmClient.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			r.logger.Error("Failed to rollback virtual key after invalid ciphertext count",
				"user_id", userID,
				"error", delErr,
			)
		}
		return false, fmt.Errorf("unexpected ciphertext count: got %d, want 1", len(ciphertexts))
	}

	// Store encrypted key in database
	if err := r.dbClient.InsertVirtualKey(ctx, userID, ciphertexts[0]); err != nil {
		// Rollback: delete the key from LiteLLM since we can't store it
		if delErr := r.litellmClient.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			r.logger.Error("Failed to rollback virtual key after database insert failure",
				"user_id", userID,
				"error", delErr,
			)
		}
		return false, fmt.Errorf("store virtual key: %w", err)
	}

	r.logger.Info("Created and stored virtual key for user",
		"user_id", userID,
	)

	return true, nil
}

// Health checks the health of the reconciler components.
func (r *Reconciler) Health() error {
	// Check database connection
	if r.dbClient == nil {
		return fmt.Errorf("database client not initialized")
	}
	if err := r.dbClient.Health(); err != nil {
		return fmt.Errorf("database unhealthy: %w", err)
	}

	// Check ArgoCD connectivity
	if r.argoCDManager == nil {
		return fmt.Errorf("argocd manager not initialized")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := r.argoCDManager.ListApplications(ctx); err != nil {
		return fmt.Errorf("argocd unhealthy: %w", err)
	}

	return nil
}
