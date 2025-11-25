package controller

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/tempestteam/atlas-operator/pkg/argocd"
	"github.com/tempestteam/atlas-operator/pkg/config"
	"github.com/tempestteam/atlas-operator/pkg/database"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Reconciler handles the main reconciliation loop.
type Reconciler struct {
	dbClient      DatabaseClient
	argoCDManager ArgoCDManager
	config        *config.Config
	logger        *slog.Logger
	stopCh        chan struct{}
}

// NewReconciler creates a new reconciler.
func NewReconciler(
	dbClient DatabaseClient,
	argoCDManager ArgoCDManager,
	config *config.Config,
	logger *slog.Logger,
) *Reconciler {
	return &Reconciler{
		dbClient:      dbClient,
		argoCDManager: argoCDManager,
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

	// Get current users from database
	dbUsers, err := r.dbClient.GetUsers()
	if err != nil {
		return fmt.Errorf("failed to get users from database: %w", err)
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
	}

	// Delete applications for removed users
	deleted := 0
	for userID := range appUserMap {
		if _, exists := dbUserMap[userID]; !exists {
			r.logger.Info("Deleting application for removed user",
				"user_id", userID,
			)
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
		"created", created,
		"deleted", deleted,
	)

	return nil
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
