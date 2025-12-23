package service

import (
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tempestteam/atlas/apps/cortex/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

func (s *Service) HandleDownload(w http.ResponseWriter, r *http.Request) {
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

	// Verify object exists, not deleted, and user owns it (RLS enforces user isolation)
	_, err = withUserContextRead(ctx, userID, func(q *repo.Queries) (repo.CortexObject, error) {
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

	// Download from GCS
	storage, err := StorageFromContext(ctx)
	if err != nil {
		s.Logger.Error("failed to get storage", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	reader, err := storage.Download(ctx, id)
	if err != nil {
		s.Logger.Error("download failed", "error", err, "id", id)
		http.Error(w, "Download failed", http.StatusInternalServerError)
		return
	}
	defer func() {
		if err := reader.Close(); err != nil {
			s.Logger.Error("failed to close reader", "error", err, "id", id)
		}
	}()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+id.String()+"\"")
	if _, err := io.Copy(w, reader); err != nil {
		s.Logger.Error("failed to copy response", "error", err, "id", id)
	}
}
