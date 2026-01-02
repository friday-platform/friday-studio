package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
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

// convertMetadataValue converts query string values to appropriate types for JSONB containment.
// The @> operator is type-sensitive, so we must match the stored types exactly.
//
// Known artifact storage metadata fields:
// - artifact_id: string (UUID)
// - revision: int
// - artifact_type: string
// - title: string
// - summary: string
// - workspace_id: string (UUID)
// - chat_id: string (UUID)
// - is_latest: bool
// - created_at: string (ISO 8601)
// - revision_message: string.
func convertMetadataValue(field, value string) (interface{}, error) {
	switch field {
	case "revision":
		// Must be stored as integer in JSONB
		num, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("revision must be an integer")
		}
		// Validate range: revisions should be positive
		if num < 1 {
			return nil, fmt.Errorf("revision must be >= 1")
		}
		return num, nil

	case "is_latest":
		// Must be stored as boolean in JSONB
		switch value {
		case "true":
			return true, nil
		case "false":
			return false, nil
		default:
			return nil, fmt.Errorf("is_latest must be 'true' or 'false'")
		}

	case "artifact_id", "artifact_type", "title", "summary", "workspace_id", "chat_id", "created_at", "revision_message":
		// String fields - no conversion needed
		return value, nil

	default:
		// Unknown fields: try best-effort conversion for extensibility
		// This allows future fields without breaking existing clients
		switch value {
		case "true":
			return true, nil
		case "false":
			return false, nil
		default:
			if num, err := strconv.ParseInt(value, 10, 64); err == nil {
				return num, nil
			}
			// Default to string
			return value, nil
		}
	}
}

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

	// Build metadata filter from query params with "metadata." prefix
	// Type conversion must match stored JSONB types exactly for @> containment operator
	metadataFilter := make(map[string]interface{})
	for key, values := range r.URL.Query() {
		if strings.HasPrefix(key, "metadata.") && len(values) > 0 {
			fieldName := strings.TrimPrefix(key, "metadata.")
			value := values[0]

			// Convert based on known field types for artifact storage
			converted, err := convertMetadataValue(fieldName, value)
			if err != nil {
				http.Error(w, fmt.Sprintf("Invalid value for metadata.%s: %s", fieldName, err.Error()), http.StatusBadRequest)
				return
			}
			metadataFilter[fieldName] = converted
		}
	}

	// Use metadata filtering if any metadata.* params were provided
	var objects []repo.CortexObject

	if len(metadataFilter) > 0 {
		// Marshal metadata filter to JSONB
		metadataJSON, marshalErr := json.Marshal(metadataFilter)
		if marshalErr != nil {
			http.Error(w, "Invalid metadata filter", http.StatusBadRequest)
			return
		}

		// Use new metadata filter query
		objects, err = withUserContextRead(ctx, userID, func(q *repo.Queries) ([]repo.CortexObject, error) {
			return q.ListObjectsWithMetadataFilter(ctx, repo.ListObjectsWithMetadataFilterParams{
				UserID:   userID,
				Metadata: metadataJSON,
				Limit:    limit,
				Offset:   offset,
			})
		})
	} else {
		// Use legacy query for backward compatibility (workspace_id/chat_id params)
		workspaceID := r.URL.Query().Get("workspace_id")
		chatID := r.URL.Query().Get("chat_id")

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

		objects, err = withUserContextRead(ctx, userID, func(q *repo.Queries) ([]repo.CortexObject, error) {
			return q.ListObjects(ctx, params)
		})
	}
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
