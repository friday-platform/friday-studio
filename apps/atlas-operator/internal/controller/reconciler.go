package controller

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/argocd"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/config"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/litellm"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	// usersPageSize is the number of users to fetch per database query.
	usersPageSize = 100

	// verifyBatchSize is the max number of users to verify per verification cycle.
	// At 10-cycle intervals (30s each = 5min), 1000 users are fully audited in ~100min.
	verifyBatchSize = 50
)

// Metrics holds Prometheus metrics for the reconciler.
type Metrics struct {
	UsersTotal               prometheus.Gauge
	ApplicationsCreatedTotal prometheus.Counter
	ApplicationsDeletedTotal prometheus.Counter
	ReconciliationDuration   *prometheus.HistogramVec
}

// Deps holds all dependencies for the Reconciler.
type Deps struct {
	DB      DatabaseClient
	ArgoCD  ArgoCDManager
	Pool    PoolManager
	LiteLLM LiteLLMClient
	Cypher  CypherClient
	Config  *config.Config
	Logger  *slog.Logger
	Metrics *Metrics
}

// Reconciler handles the main reconciliation loop.
type Reconciler struct {
	Deps
	stopCh         chan struct{}
	reconcileCount int
	verifyCursor   int // index into user list for rotating verification
}

// NewReconciler creates a new reconciler.
func NewReconciler(deps Deps) *Reconciler {
	return &Reconciler{
		Deps:   deps,
		stopCh: make(chan struct{}),
	}
}

// Start begins the reconciliation loop.
func (r *Reconciler) Start(ctx context.Context) error {
	r.Logger.Info("Starting reconciliation loop",
		"interval", r.Config.ReconciliationInterval,
	)

	// Run initial reconciliation
	start := time.Now()
	if err := r.Reconcile(ctx); err != nil {
		r.Logger.Error("Initial reconciliation failed", "error", err, "duration", time.Since(start))
		r.recordReconciliationDuration(start, "error")
	} else {
		r.Logger.Info("Initial reconciliation completed", "duration", time.Since(start))
		r.recordReconciliationDuration(start, "success")
	}

	// Start the periodic reconciliation
	ticker := time.NewTicker(r.Config.ReconciliationInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			r.Logger.Info("Stopping reconciliation loop")
			return ctx.Err()
		case <-r.stopCh:
			r.Logger.Info("Reconciliation loop stopped")
			return nil
		case <-ticker.C:
			start := time.Now()
			if err := r.Reconcile(ctx); err != nil {
				r.Logger.Error("Reconciliation failed",
					"error", err,
					"duration", time.Since(start),
				)
				r.recordReconciliationDuration(start, "error")
			} else {
				r.Logger.Debug("Reconciliation completed",
					"duration", time.Since(start),
				)
				r.recordReconciliationDuration(start, "success")
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
	r.Logger.Debug("Starting reconciliation")

	// Get current users from database using cursor-based pagination
	var dbUsers []database.User
	afterID := ""
	for {
		page, err := r.DB.GetUsers(ctx, usersPageSize, afterID)
		if err != nil {
			return fmt.Errorf("failed to get users from database: %w", err)
		}
		dbUsers = append(dbUsers, page...)
		if len(page) < usersPageSize {
			break
		}
		afterID = page[len(page)-1].ID
	}

	// Update users total metric
	r.setUsersTotal(len(dbUsers))

	// Get existing ArgoCD Applications
	apps, err := r.ArgoCD.ListApplications(ctx)
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
			r.Logger.Warn("Failed to get user ID from application",
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
			r.Logger.Info("Creating application for new user",
				"user_id", userID,
			)
			if err := r.ArgoCD.CreateApplication(ctx, userID); err != nil {
				r.Logger.Error("Failed to create application",
					"error", err,
					"user_id", userID,
				)
				// Continue with other users
			} else {
				created++
				r.incApplicationsCreated()
			}
		}

		// Create LiteLLM virtual key if enabled and user doesn't have one
		if r.LiteLLM != nil && r.Cypher != nil {
			keyCreated, err := r.ensureVirtualKey(ctx, userID)
			if err != nil {
				r.Logger.Error("Failed to ensure virtual key",
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
			r.Logger.Info("Cleaning up removed user",
				"user_id", userID,
			)

			// Revoke LiteLLM virtual key first (if LiteLLM is enabled)
			if r.LiteLLM != nil {
				if err := r.LiteLLM.DeleteVirtualKeyByUserID(ctx, userID); err != nil {
					r.Logger.Error("Failed to revoke virtual key",
						"error", err,
						"user_id", userID,
					)
					// Continue - key may not exist or LiteLLM may be unavailable
				} else {
					keysDeleted++
				}
			}

			// Delete ArgoCD application
			if err := r.ArgoCD.DeleteApplication(ctx, userID); err != nil {
				r.Logger.Error("Failed to delete application",
					"error", err,
					"user_id", userID,
				)
				// Continue with other users
			} else {
				deleted++
				r.incApplicationsDeleted()
			}
		}
	}

	// Periodic verification: check for orphaned DB rows every 10 cycles
	r.reconcileCount++
	if r.LiteLLM != nil && r.reconcileCount%10 == 0 {
		r.verifyVirtualKeys(ctx, dbUsers)
	}

	r.Logger.Info("Reconciliation completed",
		"db_users", len(dbUsers),
		"existing_apps", len(apps),
		"apps_created", created,
		"apps_deleted", deleted,
		"keys_created", keysCreated,
		"keys_deleted", keysDeleted,
	)

	// Replenish pool if enabled
	if r.Pool != nil {
		if _, err := r.Pool.Replenish(ctx); err != nil {
			r.Logger.Error("Failed to replenish pool", "error", err)
			// Don't fail reconciliation for pool errors
		}
	}

	return nil
}

// ensureVirtualKey creates a LiteLLM virtual key for a user if they don't already have one.
// Returns (true, nil) if a new key was created, (false, nil) if user already has a key,
// or (false, error) if key creation failed.
func (r *Reconciler) ensureVirtualKey(ctx context.Context, userID string) (bool, error) {
	// Check if user already has a virtual key in our DB
	hasKey, err := r.DB.HasVirtualKey(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("check virtual key: %w", err)
	}
	if hasKey {
		return false, nil // Already has a key, nothing to do
	}

	// DB says no key — check if litellm has an orphaned key and clean it up
	litellmHasKey, err := r.LiteLLM.HasKey(ctx, userID)
	if err != nil {
		r.Logger.Warn("Failed to check LiteLLM for existing key, proceeding with create",
			"user_id", userID,
			"error", err.Error(),
		)
	} else if litellmHasKey {
		r.Logger.Warn("Found orphaned LiteLLM key (not in DB), deleting before recreate",
			"user_id", userID,
		)
		if delErr := r.LiteLLM.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			return false, fmt.Errorf("delete orphaned litellm key: %w", delErr)
		}
	}

	// Create virtual key via LiteLLM
	req := litellm.CreateVirtualKeyRequest{
		UserID:         userID,
		KeyAlias:       litellm.KeyAliasForUser(userID),
		MaxBudget:      litellm.Float64Ptr(r.Config.LiteLLMDefaultBudget),
		BudgetDuration: r.Config.LiteLLMBudgetDuration,
	}

	resp, err := r.LiteLLM.CreateVirtualKey(ctx, req)
	// Handle orphaned key: exists in LiteLLM but not in our database (checked above).
	// This happens when a previous reconciliation created the key but failed to store it.
	if err != nil && strings.Contains(err.Error(), "already exists") {
		r.Logger.Warn("Found orphaned virtual key in LiteLLM, deleting and recreating",
			"user_id", userID,
		)
		if delErr := r.LiteLLM.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			return false, fmt.Errorf("delete orphaned virtual key: %w", delErr)
		}
		resp, err = r.LiteLLM.CreateVirtualKey(ctx, req)
	}
	if err != nil {
		return false, fmt.Errorf("create virtual key: %w", err)
	}

	// Encrypt the key via Cypher
	ciphertexts, err := r.Cypher.Encrypt(ctx, userID, []string{resp.Key})
	if err != nil {
		// Rollback: delete the key from LiteLLM since we can't store it
		if delErr := r.LiteLLM.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			r.Logger.Error("Failed to rollback virtual key after encryption failure",
				"user_id", userID,
				"error", delErr,
			)
		}
		return false, fmt.Errorf("encrypt virtual key: %w", err)
	}

	if len(ciphertexts) != 1 {
		// Rollback: unexpected response from Cypher
		if delErr := r.LiteLLM.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			r.Logger.Error("Failed to rollback virtual key after invalid ciphertext count",
				"user_id", userID,
				"error", delErr,
			)
		}
		return false, fmt.Errorf("unexpected ciphertext count: got %d, want 1", len(ciphertexts))
	}

	// Store encrypted key in database
	if err := r.DB.InsertVirtualKey(ctx, userID, ciphertexts[0]); err != nil {
		// Rollback: delete the key from LiteLLM since we can't store it
		if delErr := r.LiteLLM.DeleteVirtualKeyByUserID(ctx, userID); delErr != nil {
			r.Logger.Error("Failed to rollback virtual key after database insert failure",
				"user_id", userID,
				"error", delErr,
			)
		}
		return false, fmt.Errorf("store virtual key: %w", err)
	}

	r.Logger.Info("Created and stored virtual key for user",
		"user_id", userID,
	)

	return true, nil
}

// verifyVirtualKeys checks a batch of users for orphaned DB rows (DB says key exists but litellm
// doesn't have it). Rotates through the full user list across successive calls using verifyCursor.
// When an orphan is found, the DB row is deleted so the next reconciliation cycle recreates the key.
func (r *Reconciler) verifyVirtualKeys(ctx context.Context, users []database.User) {
	if len(users) == 0 {
		return
	}

	// Reset cursor if it's past the end (user list shrank)
	if r.verifyCursor >= len(users) {
		r.verifyCursor = 0
	}

	start := r.verifyCursor
	end := min(start+verifyBatchSize, len(users))
	batch := users[start:end]
	r.verifyCursor = end % len(users)

	cleaned := 0
	for _, user := range batch {
		hasDBKey, err := r.DB.HasVirtualKey(ctx, user.ID)
		if err != nil {
			r.Logger.Warn("Failed to check DB virtual key during verification",
				"user_id", user.ID,
				"error", err.Error(),
			)
			continue
		}
		if !hasDBKey {
			continue
		}

		hasLiteLLMKey, err := r.LiteLLM.HasKey(ctx, user.ID)
		if err != nil {
			r.Logger.Warn("Failed to check LiteLLM key during verification",
				"user_id", user.ID,
				"error", err.Error(),
			)
			continue
		}
		if !hasLiteLLMKey {
			r.Logger.Warn("Orphaned DB virtual key detected (not in LiteLLM), deleting DB row",
				"user_id", user.ID,
			)
			if err := r.DB.DeleteVirtualKey(ctx, user.ID); err != nil {
				r.Logger.Error("Failed to delete orphaned DB virtual key",
					"user_id", user.ID,
					"error", err.Error(),
				)
				continue
			}
			cleaned++
		}
	}

	if cleaned > 0 {
		r.Logger.Info("Virtual key verification completed",
			"orphaned_db_keys_cleaned", cleaned,
			"batch_size", len(batch),
		)
	}
}

// Health checks the health of the reconciler components.
func (r *Reconciler) Health() error {
	// Check database connection
	if r.DB == nil {
		return fmt.Errorf("database client not initialized")
	}
	if err := r.DB.Health(); err != nil {
		return fmt.Errorf("database unhealthy: %w", err)
	}

	// Check ArgoCD connectivity
	if r.ArgoCD == nil {
		return fmt.Errorf("argocd manager not initialized")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := r.ArgoCD.ListApplications(ctx); err != nil {
		return fmt.Errorf("argocd unhealthy: %w", err)
	}

	return nil
}

// Metrics helper methods - nil-safe for when metrics are not configured.

func (r *Reconciler) setUsersTotal(count int) {
	if r.Metrics != nil {
		r.Metrics.UsersTotal.Set(float64(count))
	}
}

func (r *Reconciler) incApplicationsCreated() {
	if r.Metrics != nil {
		r.Metrics.ApplicationsCreatedTotal.Inc()
	}
}

func (r *Reconciler) incApplicationsDeleted() {
	if r.Metrics != nil {
		r.Metrics.ApplicationsDeletedTotal.Inc()
	}
}

func (r *Reconciler) recordReconciliationDuration(start time.Time, status string) {
	if r.Metrics != nil {
		r.Metrics.ReconciliationDuration.WithLabelValues(status).Observe(time.Since(start).Seconds())
	}
}
