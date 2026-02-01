package service

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tempestteam/atlas/apps/persona/litellmrepo"
	"github.com/tempestteam/atlas/apps/persona/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
	"github.com/tempestteam/atlas/pkg/x/middleware/pgxdb"
)

type MeResponse struct {
	ID           string  `json:"id"`
	FullName     string  `json:"full_name"`
	Email        string  `json:"email"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	DisplayName  *string `json:"display_name"`
	ProfilePhoto *string `json:"profile_photo"`
	Usage        float64 `json:"usage"`
}

// nullIfEmpty returns nil for empty strings, pointer to string otherwise.
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// liteLLMDBFromContext retrieves the LiteLLM database pool from context.
// Returns nil if the LiteLLM pool is not configured.
func liteLLMDBFromContext(ctx context.Context) *pgxpool.Pool {
	pool, err := pgxdb.PoolFromContext(ctx, litellmDBContextKey)
	if err != nil {
		return nil
	}
	return pool
}

// getUsage queries the LiteLLM database for the user's spend/max_budget ratio.
// Returns 0 on any error (no key, DB down, zero budget).
func getUsage(ctx context.Context, db litellmrepo.DBTX, userID string) float64 {
	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	// Must match atlas-operator/pkg/litellm.KeyAliasForUser format.
	keyAlias := pgtype.Text{String: keyAliasPrefix + userID, Valid: true}
	row, err := litellmrepo.New(db).GetKeyUsage(queryCtx, keyAlias)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			httplog.LogEntry(ctx).Warn("getUsage: LiteLLM query failed", "error", err, "userID", userID)
		}
		return 0
	}

	if row.MaxBudget <= 0 {
		return 0
	}

	ratio := row.Spend / row.MaxBudget
	if ratio < 0 {
		return 0
	}
	return min(ratio, 1.0)
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	userID, err := jwt.MustGetUserID(ctx)
	if err != nil {
		log.Warn("handleMe: no user ID in context", "error", err)
		writeJSONError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	user, err := withUserContextRead(ctx, userID, func(q *repo.Queries) (repo.GetUserByIDRow, error) {
		return q.GetUserByID(ctx, userID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			log.Warn("handleMe: user not found", "userID", userID)
			writeJSONError(w, "user not found", http.StatusNotFound)
			return
		}
		log.Error("handleMe: database error", "error", err, "userID", userID)
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Query LiteLLM for usage — direct pool call, no RLS/transaction needed.
	var usage float64
	if pool := liteLLMDBFromContext(ctx); pool != nil {
		usage = getUsage(ctx, pool, userID)
	}

	resp := MeResponse{
		ID:           user.ID,
		FullName:     user.FullName,
		Email:        user.Email,
		CreatedAt:    user.CreatedAt.Time.Format("2006-01-02T15:04:05.000000Z07:00"),
		UpdatedAt:    user.UpdatedAt.Time.Format("2006-01-02T15:04:05.000000Z07:00"),
		DisplayName:  nullIfEmpty(user.DisplayName),
		ProfilePhoto: nullIfEmpty(user.ProfilePhoto),
		Usage:        usage,
	}

	writeJSON(w, resp, http.StatusOK)
}
