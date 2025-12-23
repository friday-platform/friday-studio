package service

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tempestteam/atlas/apps/cortex/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

func (s *Service) HandleDelete(w http.ResponseWriter, r *http.Request) {
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

	// Delete via trigger-based soft delete (RLS enforces user isolation)
	err = withUserContext(ctx, userID, func(q *repo.Queries) error {
		return q.DeleteObject(ctx, pgID)
	})
	if err != nil {
		s.Logger.Error("delete failed", "error", err, "id", id)
		http.Error(w, "Delete failed", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
