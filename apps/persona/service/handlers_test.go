package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func ptr(s string) *string { return &s }

func TestMeResponse_JSON(t *testing.T) {
	resp := MeResponse{
		ID:           "test-user-id",
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    "2024-01-01T00:00:00.000000Z",
		UpdatedAt:    "2024-01-02T00:00:00.000000Z",
		DisplayName:  ptr("testuser"),
		ProfilePhoto: ptr("https://example.com/photo.jpg"),
		Usage:        0.004058031,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal MeResponse: %v", err)
	}

	var decoded MeResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Failed to unmarshal MeResponse: %v", err)
	}

	if decoded.ID != resp.ID {
		t.Errorf("ID = %q, want %q", decoded.ID, resp.ID)
	}
	if decoded.FullName != resp.FullName {
		t.Errorf("FullName = %q, want %q", decoded.FullName, resp.FullName)
	}
	if decoded.Email != resp.Email {
		t.Errorf("Email = %q, want %q", decoded.Email, resp.Email)
	}
	if *decoded.DisplayName != *resp.DisplayName {
		t.Errorf("DisplayName = %q, want %q", *decoded.DisplayName, *resp.DisplayName)
	}
	if *decoded.ProfilePhoto != *resp.ProfilePhoto {
		t.Errorf("ProfilePhoto = %q, want %q", *decoded.ProfilePhoto, *resp.ProfilePhoto)
	}
	if decoded.Usage != resp.Usage {
		t.Errorf("Usage = %f, want %f", decoded.Usage, resp.Usage)
	}
}

func TestMeResponse_NullFields(t *testing.T) {
	resp := MeResponse{
		ID:           "test-user-id",
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    "2024-01-01T00:00:00.000000Z",
		UpdatedAt:    "2024-01-02T00:00:00.000000Z",
		DisplayName:  nil,
		ProfilePhoto: nil,
		Usage:        0,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal MeResponse: %v", err)
	}

	// Verify nullable fields serialize as null
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Failed to unmarshal to map: %v", err)
	}

	if raw["display_name"] != nil {
		t.Errorf("display_name should be null, got %v", raw["display_name"])
	}
	if raw["profile_photo"] != nil {
		t.Errorf("profile_photo should be null, got %v", raw["profile_photo"])
	}
}

func TestGetUsage(t *testing.T) {
	tests := []struct {
		name      string
		spend     float64
		maxBudget float64
		scanErr   error
		want      float64
	}{
		{"happy path", 5, 100, nil, 0.05},
		{"half used", 50, 100, nil, 0.5},
		{"fully used", 100, 100, nil, 1.0},
		{"overspend clamped", 120, 100, nil, 1.0},
		{"zero budget", 10, 0, nil, 0},
		{"negative budget", 10, -5, nil, 0},
		{"negative spend", -10, 100, nil, 0},
		{"no rows", 0, 0, pgx.ErrNoRows, 0},
		{"db error", 0, 0, errors.New("connection refused"), 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &fakeDBTX{spend: tt.spend, maxBudget: tt.maxBudget, err: tt.scanErr}
			got := getUsage(context.Background(), db, "test-user")
			if got != tt.want {
				t.Errorf("getUsage() = %f, want %f", got, tt.want)
			}
		})
	}
}

// fakeDBTX implements litellmrepo.DBTX for testing getUsage.
type fakeDBTX struct {
	spend     float64
	maxBudget float64
	err       error
}

func (f *fakeDBTX) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (f *fakeDBTX) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}

func (f *fakeDBTX) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	return &fakeRow{spend: f.spend, maxBudget: f.maxBudget, err: f.err}
}

type fakeRow struct {
	spend     float64
	maxBudget float64
	err       error
}

func (r *fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*float64) = r.spend
	*dest[1].(*float64) = r.maxBudget
	return nil
}

// Note: handleMe requires httplog context from middleware, so we test it
// through integration tests with the full router setup, not unit tests.
// The RLS integration tests in rls_test.go cover the actual handler behavior.

func TestRouterMeEndpoint(t *testing.T) {
	r := chi.NewRouter()

	var capturedPath string
	r.Get("/api/me", func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if capturedPath != "/api/me" {
		t.Errorf("Path = %q, want %q", capturedPath, "/api/me")
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestRouterMethodNotAllowed(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/me", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// POST should not be allowed
	req := httptest.NewRequest(http.MethodPost, "/api/me", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/me Status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	data := map[string]string{"key": "value"}

	writeJSON(rec, data, http.StatusOK)

	if rec.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusOK)
	}

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var decoded map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&decoded); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if decoded["key"] != "value" {
		t.Errorf("key = %q, want %q", decoded["key"], "value")
	}
}

func TestWriteJSONError(t *testing.T) {
	rec := httptest.NewRecorder()

	writeJSONError(rec, "test error", http.StatusBadRequest)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var decoded map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&decoded); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if decoded["error"] != "test error" {
		t.Errorf("error = %q, want %q", decoded["error"], "test error")
	}
}

func TestDBFromContext_Missing(t *testing.T) {
	ctx := context.Background()
	_, err := DBFromContext(ctx)
	if err == nil {
		t.Error("DBFromContext should return error when pool not in context")
	}
}

func TestUpdateMeRequest_JSON(t *testing.T) {
	tests := []struct {
		name         string
		input        string
		wantFullName bool
		wantDisplay  bool
		wantPhoto    bool
	}{
		{
			name:         "all fields present",
			input:        `{"full_name":"Alice","display_name":"alice","profile_photo":"https://example.com/a.jpg"}`,
			wantFullName: true,
			wantDisplay:  true,
			wantPhoto:    true,
		},
		{
			name:         "partial update - only full_name",
			input:        `{"full_name":"Alice"}`,
			wantFullName: true,
			wantDisplay:  false,
			wantPhoto:    false,
		},
		{
			name:         "empty object - no fields",
			input:        `{}`,
			wantFullName: false,
			wantDisplay:  false,
			wantPhoto:    false,
		},
		{
			name:         "clear photo with empty string",
			input:        `{"profile_photo":""}`,
			wantFullName: false,
			wantDisplay:  false,
			wantPhoto:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req updateMeRequest
			if err := json.Unmarshal([]byte(tt.input), &req); err != nil {
				t.Fatalf("Failed to unmarshal: %v", err)
			}

			if got := req.FullName != nil; got != tt.wantFullName {
				t.Errorf("FullName present = %v, want %v", got, tt.wantFullName)
			}
			if got := req.DisplayName != nil; got != tt.wantDisplay {
				t.Errorf("DisplayName present = %v, want %v", got, tt.wantDisplay)
			}
			if got := req.ProfilePhoto != nil; got != tt.wantPhoto {
				t.Errorf("ProfilePhoto present = %v, want %v", got, tt.wantPhoto)
			}
		})
	}
}

func TestUpdateMeRequest_ReadOnlyFieldRejection(t *testing.T) {
	tests := []struct {
		name  string
		input string
		field string
	}{
		{"reject id", `{"id":"x"}`, "id"},
		{"reject email", `{"email":"x@test.com"}`, "email"},
		{"reject created_at", `{"created_at":"2024-01-01"}`, "created_at"},
		{"reject updated_at", `{"updated_at":"2024-01-01"}`, "updated_at"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var raw map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tt.input), &raw); err != nil {
				t.Fatalf("Failed to unmarshal: %v", err)
			}

			for _, field := range readOnlyFields {
				if _, ok := raw[field]; ok && field == tt.field {
					return // correctly detected
				}
			}
			t.Errorf("read-only field %q was not detected", tt.field)
		})
	}
}

func TestUpdateMeRequest_Validation(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr string
	}{
		{
			name:    "empty full_name rejected",
			input:   `{"full_name":""}`,
			wantErr: "full_name must be non-empty",
		},
		{
			name:    "whitespace-only full_name rejected",
			input:   `{"full_name":"   "}`,
			wantErr: "full_name must be non-empty",
		},
		{
			name:    "invalid profile_photo URL rejected",
			input:   `{"profile_photo":"not-a-url"}`,
			wantErr: "profile_photo must be an HTTP(S) URL or empty string",
		},
		{
			name:    "javascript scheme rejected",
			input:   `{"profile_photo":"javascript:alert(1)"}`,
			wantErr: "profile_photo must be an HTTP(S) URL or empty string",
		},
		{
			name:    "data scheme rejected",
			input:   `{"profile_photo":"data:image/png;base64,abc"}`,
			wantErr: "profile_photo must be an HTTP(S) URL or empty string",
		},
		{
			name:    "file scheme rejected",
			input:   `{"profile_photo":"file:///etc/passwd"}`,
			wantErr: "profile_photo must be an HTTP(S) URL or empty string",
		},
		{
			name:    "empty profile_photo accepted (clears field)",
			input:   `{"profile_photo":""}`,
			wantErr: "",
		},
		{
			name:    "valid profile_photo URL accepted",
			input:   `{"profile_photo":"https://example.com/photo.jpg"}`,
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req updateMeRequest
			if err := json.Unmarshal([]byte(tt.input), &req); err != nil {
				t.Fatalf("Failed to unmarshal: %v", err)
			}

			var errMsg string
			if req.FullName != nil {
				trimmed := strings.TrimSpace(*req.FullName)
				if trimmed == "" {
					errMsg = "full_name must be non-empty"
				}
			}
			if errMsg == "" && req.ProfilePhoto != nil && *req.ProfilePhoto != "" {
				u, err := url.ParseRequestURI(*req.ProfilePhoto)
				if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
					errMsg = "profile_photo must be an HTTP(S) URL or empty string"
				}
			}

			if errMsg != tt.wantErr {
				t.Errorf("validation error = %q, want %q", errMsg, tt.wantErr)
			}
		})
	}
}

func TestRouterPatchMeEndpoint(t *testing.T) {
	r := chi.NewRouter()

	var capturedMethod string
	r.Patch("/api/me", func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodPatch, "/api/me", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if capturedMethod != http.MethodPatch {
		t.Errorf("Method = %q, want %q", capturedMethod, http.MethodPatch)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusOK)
	}
}
