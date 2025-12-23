package service

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tempestteam/atlas/apps/cortex/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

const (
	defaultLimit int32 = 100
	maxLimit     int32 = 1000
)

// ObjectResponse is the JSON response format for objects.
type ObjectResponse struct {
	ID          string          `json:"id"`
	UserID      string          `json:"user_id"`
	ContentSize *int64          `json:"content_size"`
	Metadata    json.RawMessage `json:"metadata"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
}

// toObjectResponse converts a database object to the JSON response format.
func toObjectResponse(obj repo.CortexObject) ObjectResponse {
	var contentSize *int64
	if obj.ContentSize.Valid {
		contentSize = &obj.ContentSize.Int64
	}
	return ObjectResponse{
		ID:          uuid.UUID(obj.ID.Bytes).String(),
		UserID:      obj.UserID,
		ContentSize: contentSize,
		Metadata:    obj.Metadata,
		CreatedAt:   obj.CreatedAt.Time.Format(time.RFC3339),
		UpdatedAt:   obj.UpdatedAt.Time.Format(time.RFC3339),
	}
}

func (s *Service) HandleList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	userID, err := jwt.MustGetUserID(ctx)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Query params for filtering
	workspaceID := r.URL.Query().Get("workspace_id")
	chatID := r.URL.Query().Get("chat_id")

	// Pagination params (int32 to match sqlc generated types)
	limit := defaultLimit
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if parsed, err := strconv.ParseInt(limitStr, 10, 32); err == nil && parsed > 0 {
			limit = int32(parsed)
		}
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	var offset int32
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		if parsed, err := strconv.ParseInt(offsetStr, 10, 32); err == nil && parsed >= 0 {
			offset = int32(parsed)
		}
	}

	params := repo.ListObjectsParams{
		UserID: userID,
		Limit:  limit,
		Offset: offset,
	}
	if workspaceID != "" {
		params.WorkspaceID = pgtype.Text{String: workspaceID, Valid: true}
	}
	if chatID != "" {
		params.ChatID = pgtype.Text{String: chatID, Valid: true}
	}

	// List objects with RLS-scoped transaction for user isolation
	objects, err := withUserContextRead(ctx, userID, func(q *repo.Queries) ([]repo.CortexObject, error) {
		return q.ListObjects(ctx, params)
	})
	if err != nil {
		s.Logger.Error("list failed", "error", err)
		http.Error(w, "List failed", http.StatusInternalServerError)
		return
	}

	// Convert to response format
	result := make([]ObjectResponse, len(objects))
	for i, obj := range objects {
		result[i] = toObjectResponse(obj)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		s.Logger.Error("failed to encode response", "error", err)
	}
}
