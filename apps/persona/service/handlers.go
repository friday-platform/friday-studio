package service

import (
	"errors"
	"net/http"

	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5"

	"github.com/tempestteam/atlas/apps/persona/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

type MeResponse struct {
	ID           string  `json:"id"`
	FullName     string  `json:"full_name"`
	Email        string  `json:"email"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	DisplayName  *string `json:"display_name"`
	ProfilePhoto *string `json:"profile_photo"`
}

// nullIfEmpty returns nil for empty strings, pointer to string otherwise.
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
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
