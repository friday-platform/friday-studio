package service

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tempestteam/atlas/apps/cortex/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

// POST/PUT /objects/:id/metadata.
func (s *Service) HandleSetMetadata(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	idStr := chi.URLParam(r, "id")

	userID, err := jwt.MustGetUserID(ctx)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	pgID := pgtype.UUID{Bytes: id, Valid: true}

	var metadata json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&metadata); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Verify object exists, user owns it, and update metadata (RLS enforces user isolation)
	err = withUserContext(ctx, userID, func(q *repo.Queries) error {
		_, err := q.GetObjectForUser(ctx, repo.GetObjectForUserParams{
			ID:     pgID,
			UserID: userID,
		})
		if err != nil {
			return err
		}
		return q.UpdateMetadata(ctx, repo.UpdateMetadataParams{
			ID:       pgID,
			Metadata: metadata,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, "Object not found", http.StatusNotFound)
			return
		}
		s.Logger.Error("failed to set metadata", "error", err, "id", id)
		http.Error(w, "Failed to set metadata", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// GET /objects/:id/metadata.
func (s *Service) HandleGetMetadata(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	idStr := chi.URLParam(r, "id")

	userID, err := jwt.MustGetUserID(ctx)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	// Verify object exists and user owns it (RLS enforces user isolation)
	obj, err := withUserContextRead(ctx, userID, func(q *repo.Queries) (repo.CortexObject, error) {
		return q.GetObjectForUser(ctx, repo.GetObjectForUserParams{
			ID:     pgtype.UUID{Bytes: id, Valid: true},
			UserID: userID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, "Object not found", http.StatusNotFound)
			return
		}
		s.Logger.Error("failed to get object", "error", err, "id", id)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(toObjectResponse(obj)); err != nil {
		s.Logger.Error("failed to encode response", "error", err)
	}
}
