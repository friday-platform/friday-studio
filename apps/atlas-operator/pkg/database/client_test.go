package database

import (
	"log/slog"
	"math"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tempestteam/atlas/apps/atlas-operator/repo"
)

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

	err := client.Close()
	if err != nil {
		t.Errorf("unexpected error with nil pool: %v", err)
	}
}

func TestHealth_NilPool(t *testing.T) {
	client := &Client{
		pool: nil,
	}

	err := client.Health()
	if err == nil {
		t.Error("expected error for nil pool, got nil")
	}

	expectedMsg := "database connection not initialized"
	if err.Error() != expectedMsg {
		t.Errorf("expected error '%s', got '%s'", expectedMsg, err.Error())
	}
}

func TestUserFromFirstPageRow(t *testing.T) {
	now := time.Now()
	row := &repo.GetUsersFirstPageRow{
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

	user := userFromFirstPageRow(row)

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

func TestUserFromFirstPageRow_NullBounceAuthUserID(t *testing.T) {
	now := time.Now()
	row := &repo.GetUsersFirstPageRow{
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

	user := userFromFirstPageRow(row)

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

func TestUserFromAfterCursorRow(t *testing.T) {
	now := time.Now()
	row := &repo.GetUsersAfterCursorRow{
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

	user := userFromAfterCursorRow(row)

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

func TestUserFromAfterCursorRow_NullBounceAuthUserID(t *testing.T) {
	row := &repo.GetUsersAfterCursorRow{
		ID: "user-123",
		BounceAuthUserID: pgtype.Text{
			Valid: false,
		},
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    pgtype.Timestamptz{Time: time.Now(), Valid: true},
		UpdatedAt:    pgtype.Timestamptz{Time: time.Now(), Valid: true},
		DisplayName:  "TU",
		ProfilePhoto: "",
	}

	user := userFromAfterCursorRow(row)

	if user.BounceAuthUserID != nil {
		t.Errorf("expected nil BounceAuthUserID, got %v", *user.BounceAuthUserID)
	}
}

func TestClampToInt32(t *testing.T) {
	tests := []struct {
		name      string
		v, lo, hi int
		expected  int32
	}{
		{"within range", 50, 0, 100, 50},
		{"at lo boundary", 0, 0, 100, 0},
		{"at hi boundary", 100, 0, 100, 100},
		{"below lo", -5, 0, 100, 0},
		{"above hi", 200, 0, 100, 100},
		{"lo equals hi", 50, 10, 10, 10},
		{"negative range", -50, -100, -10, -50},
		{"exceeds MaxInt32", math.MaxInt32 + 1, 0, math.MaxInt, math.MaxInt32},
		{"below MinInt32", math.MinInt, math.MinInt, 0, math.MinInt32},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clampToInt32(tt.v, tt.lo, tt.hi)
			if got != tt.expected {
				t.Errorf("clampToInt32(%d, %d, %d) = %d, want %d", tt.v, tt.lo, tt.hi, got, tt.expected)
			}
		})
	}
}
