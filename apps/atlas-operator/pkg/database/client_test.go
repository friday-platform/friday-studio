package database

import (
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tempestteam/atlas/apps/atlas-operator/repo"
)

// strPtr is a helper to create string pointers for tests.
func strPtr(s string) *string {
	return &s
}

func TestNewClient_InvalidDatabaseURL(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Test with invalid database URL
	_, err := NewClient("invalid-database-url", logger)
	if err == nil {
		t.Error("expected error for invalid database URL, got nil")
	}
}

func TestClose_WithNilPool(t *testing.T) {
	client := &Client{
		pool: nil,
	}

	// Execute
	err := client.Close()
	if err != nil {
		t.Errorf("unexpected error with nil pool: %v", err)
	}
}

func TestHealth_NilPool(t *testing.T) {
	client := &Client{
		pool: nil,
	}

	// Execute
	err := client.Health()
	if err == nil {
		t.Error("expected error for nil pool, got nil")
	}

	expectedMsg := "database connection not initialized"
	if err.Error() != expectedMsg {
		t.Errorf("expected error '%s', got '%s'", expectedMsg, err.Error())
	}
}

func TestUser_Struct(t *testing.T) {
	// Test User struct field mappings
	now := time.Now()
	user := User{
		ID:               "user-123",
		BounceAuthUserID: strPtr("auth-456"),
		FullName:         strPtr("Test User"),
		Email:            strPtr("test@example.com"),
		CreatedAt:        now,
		UpdatedAt:        now,
		DisplayName:      strPtr("TU"),
		ProfilePhoto:     strPtr("photo.jpg"),
	}

	if user.ID != "user-123" {
		t.Errorf("expected ID 'user-123', got '%s'", user.ID)
	}

	if user.BounceAuthUserID == nil || *user.BounceAuthUserID != "auth-456" {
		t.Errorf("expected BounceAuthUserID 'auth-456', got %v", user.BounceAuthUserID)
	}

	if user.FullName == nil || *user.FullName != "Test User" {
		t.Errorf("expected FullName 'Test User', got %v", user.FullName)
	}

	if user.Email == nil || *user.Email != "test@example.com" {
		t.Errorf("expected Email 'test@example.com', got %v", user.Email)
	}

	if user.CreatedAt != now {
		t.Errorf("unexpected CreatedAt time")
	}

	if user.UpdatedAt != now {
		t.Errorf("unexpected UpdatedAt time")
	}

	if user.DisplayName == nil || *user.DisplayName != "TU" {
		t.Errorf("expected DisplayName 'TU', got %v", user.DisplayName)
	}

	if user.ProfilePhoto == nil || *user.ProfilePhoto != "photo.jpg" {
		t.Errorf("expected ProfilePhoto 'photo.jpg', got %v", user.ProfilePhoto)
	}
}

func TestUserFromRow(t *testing.T) {
	now := time.Now()
	row := &repo.GetUsersRow{
		ID: "user-123",
		BounceAuthUserID: pgtype.Text{
			String: "auth-456",
			Valid:  true,
		},
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		DisplayName:  "TU",
		ProfilePhoto: "photo.jpg",
	}

	user := userFromRow(row)

	if user.ID != "user-123" {
		t.Errorf("expected ID 'user-123', got '%s'", user.ID)
	}

	if user.BounceAuthUserID == nil || *user.BounceAuthUserID != "auth-456" {
		t.Errorf("expected BounceAuthUserID 'auth-456', got %v", user.BounceAuthUserID)
	}

	if user.FullName == nil || *user.FullName != "Test User" {
		t.Errorf("expected FullName 'Test User', got %v", user.FullName)
	}

	if user.Email == nil || *user.Email != "test@example.com" {
		t.Errorf("expected Email 'test@example.com', got %v", user.Email)
	}

	if user.DisplayName == nil || *user.DisplayName != "TU" {
		t.Errorf("expected DisplayName 'TU', got %v", user.DisplayName)
	}

	if user.ProfilePhoto == nil || *user.ProfilePhoto != "photo.jpg" {
		t.Errorf("expected ProfilePhoto 'photo.jpg', got %v", user.ProfilePhoto)
	}
}

func TestUserFromRow_NullBounceAuthUserID(t *testing.T) {
	now := time.Now()
	row := &repo.GetUsersRow{
		ID: "user-123",
		BounceAuthUserID: pgtype.Text{
			String: "",
			Valid:  false, // NULL
		},
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		DisplayName:  "TU",
		ProfilePhoto: "",
	}

	user := userFromRow(row)

	if user.BounceAuthUserID != nil {
		t.Errorf("expected nil BounceAuthUserID, got %v", *user.BounceAuthUserID)
	}
}

func TestUserFromByIDRow(t *testing.T) {
	now := time.Now()
	row := &repo.GetUserByIDRow{
		ID: "user-123",
		BounceAuthUserID: pgtype.Text{
			String: "auth-456",
			Valid:  true,
		},
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		DisplayName:  "TU",
		ProfilePhoto: "photo.jpg",
	}

	user := userFromByIDRow(row)

	if user.ID != "user-123" {
		t.Errorf("expected ID 'user-123', got '%s'", user.ID)
	}

	if user.BounceAuthUserID == nil || *user.BounceAuthUserID != "auth-456" {
		t.Errorf("expected BounceAuthUserID 'auth-456', got %v", user.BounceAuthUserID)
	}

	if user.FullName == nil || *user.FullName != "Test User" {
		t.Errorf("expected FullName 'Test User', got %v", user.FullName)
	}

	if user.Email == nil || *user.Email != "test@example.com" {
		t.Errorf("expected Email 'test@example.com', got %v", user.Email)
	}

	if user.DisplayName == nil || *user.DisplayName != "TU" {
		t.Errorf("expected DisplayName 'TU', got %v", user.DisplayName)
	}

	if user.ProfilePhoto == nil || *user.ProfilePhoto != "photo.jpg" {
		t.Errorf("expected ProfilePhoto 'photo.jpg', got %v", user.ProfilePhoto)
	}
}

func TestUserFromByIDRow_NullBounceAuthUserID(t *testing.T) {
	now := time.Now()
	row := &repo.GetUserByIDRow{
		ID: "user-123",
		BounceAuthUserID: pgtype.Text{
			String: "",
			Valid:  false, // NULL
		},
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		DisplayName:  "TU",
		ProfilePhoto: "",
	}

	user := userFromByIDRow(row)

	if user.BounceAuthUserID != nil {
		t.Errorf("expected nil BounceAuthUserID, got %v", *user.BounceAuthUserID)
	}
}
