package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
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

// updateMeRequest uses *string to distinguish between:
//   - field absent (nil)    -> SQL NULL via pgtype.Text{Valid: false} -> COALESCE keeps current
//   - field present ("")    -> SQL ""   via pgtype.Text{Valid: true}  -> clears the field
//   - field present ("val") -> SQL "val" via pgtype.Text{Valid: true} -> sets the field
type updateMeRequest struct {
	FullName     *string `json:"full_name"`
	DisplayName  *string `json:"display_name"`
	ProfilePhoto *string `json:"profile_photo"`
}

// readOnlyFields that must not appear in PATCH /api/me requests.
var readOnlyFields = []string{"id", "email", "created_at", "updated_at"}

func handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	userID, err := jwt.MustGetUserID(ctx)
	if err != nil {
		log.Warn("handleUpdateMe: no user ID in context", "error", err)
		writeJSONError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Decode into raw map first to reject read-only fields.
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeJSONError(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	for _, field := range readOnlyFields {
		if _, ok := raw[field]; ok {
			writeJSONError(w, field+" cannot be modified", http.StatusBadRequest)
			return
		}
	}

	// Parse the known fields.
	var req updateMeRequest
	// Re-marshal raw to decode into struct (already validated no read-only fields).
	b, err := json.Marshal(raw)
	if err != nil {
		writeJSONError(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(b, &req); err != nil {
		writeJSONError(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate full_name: must be non-empty if provided.
	if req.FullName != nil && strings.TrimSpace(*req.FullName) == "" {
		writeJSONError(w, "full_name must be non-empty", http.StatusBadRequest)
		return
	}

	// Validate profile_photo: must be a valid HTTP(S) URL or empty string (to clear).
	if req.ProfilePhoto != nil && *req.ProfilePhoto != "" {
		u, err := url.ParseRequestURI(*req.ProfilePhoto)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			writeJSONError(w, "profile_photo must be an HTTP(S) URL or empty string", http.StatusBadRequest)
			return
		}
	}

	// Build nullable params: nil -> SQL NULL (keep), non-nil -> SQL value (set/clear).
	params := repo.UpdateUserParams{ID: userID}
	if req.FullName != nil {
		params.FullName = pgtype.Text{String: *req.FullName, Valid: true}
	}
	if req.DisplayName != nil {
		params.DisplayName = pgtype.Text{String: *req.DisplayName, Valid: true}
	}
	if req.ProfilePhoto != nil {
		params.ProfilePhoto = pgtype.Text{String: *req.ProfilePhoto, Valid: true}
	}

	user, err := withUserContextRead(ctx, userID, func(q *repo.Queries) (repo.UpdateUserRow, error) {
		return q.UpdateUser(ctx, params)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			log.Warn("handleUpdateMe: user not found", "userID", userID)
			writeJSONError(w, "user not found", http.StatusNotFound)
			return
		}
		log.Error("handleUpdateMe: database error", "error", err, "userID", userID)
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	resp := MeResponse{
		ID:           user.ID,
		FullName:     user.FullName,
		Email:        user.Email,
		CreatedAt:    user.CreatedAt.Time.Format("2006-01-02T15:04:05.000000Z07:00"),
		UpdatedAt:    user.UpdatedAt.Time.Format("2006-01-02T15:04:05.000000Z07:00"),
		DisplayName:  nullIfEmpty(user.DisplayName),
		ProfilePhoto: nullIfEmpty(user.ProfilePhoto),
	}

	writeJSON(w, resp, http.StatusOK)
}
