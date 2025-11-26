package database

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jmoiron/sqlx"
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

func TestGetUsers_Success(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Create mock database
	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	// Create client with mock
	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations
	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "bounce_auth_user_id", "full_name", "email",
		"created_at", "updated_at", "display_name", "profile_photo",
	}).
		AddRow("user-1", "auth-1", "User One", "user1@example.com", now, now, "U1", "").
		AddRow("user-2", "auth-2", "User Two", "user2@example.com", now, now, "U2", "")

	mock.ExpectQuery("SELECT (.+) FROM \"user\"").
		WithArgs("", 100).
		WillReturnRows(rows)

	// Execute
	users, err := client.GetUsers(context.Background(), 100, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify
	if len(users) != 2 {
		t.Errorf("expected 2 users, got %d", len(users))
	}

	if users[0].ID != "user-1" {
		t.Errorf("expected user-1, got %s", users[0].ID)
	}

	if users[1].ID != "user-2" {
		t.Errorf("expected user-2, got %s", users[1].ID)
	}

	// Verify all expectations met
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestGetUsers_EmptyResult(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations for empty result
	rows := sqlmock.NewRows([]string{
		"id", "bounce_auth_user_id", "full_name", "email",
		"created_at", "updated_at", "display_name", "profile_photo",
	})

	mock.ExpectQuery("SELECT (.+) FROM \"user\"").
		WithArgs("", 100).
		WillReturnRows(rows)

	// Execute
	users, err := client.GetUsers(context.Background(), 100, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify
	if len(users) != 0 {
		t.Errorf("expected 0 users, got %d", len(users))
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestGetUsers_QueryError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations for error
	mock.ExpectQuery("SELECT (.+) FROM \"user\"").
		WithArgs("", 100).
		WillReturnError(fmt.Errorf("database connection lost"))

	// Execute
	_, err = client.GetUsers(context.Background(), 100, "")
	if err == nil {
		t.Error("expected error, got nil")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestGetUsers_WithNullValues(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations with NULL values
	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "bounce_auth_user_id", "full_name", "email",
		"created_at", "updated_at", "display_name", "profile_photo",
	}).
		AddRow("user-1", nil, "User One", "user1@example.com", now, now, "U1", "").
		AddRow("user-2", "auth-2", nil, nil, now, now, nil, nil)

	mock.ExpectQuery("SELECT (.+) FROM \"user\"").
		WithArgs("", 100).
		WillReturnRows(rows)

	// Execute
	users, err := client.GetUsers(context.Background(), 100, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify
	if len(users) != 2 {
		t.Errorf("expected 2 users, got %d", len(users))
	}

	// User 1: has null bounce_auth_user_id
	if users[0].ID != "user-1" {
		t.Errorf("expected user-1, got %s", users[0].ID)
	}
	if users[0].BounceAuthUserID != nil {
		t.Errorf("expected nil BounceAuthUserID, got %s", *users[0].BounceAuthUserID)
	}

	// User 2: has null full_name and email
	if users[1].ID != "user-2" {
		t.Errorf("expected user-2, got %s", users[1].ID)
	}
	if users[1].FullName != nil {
		t.Errorf("expected nil FullName, got %s", *users[1].FullName)
	}
	if users[1].Email != nil {
		t.Errorf("expected nil Email, got %s", *users[1].Email)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestGetUser_Success(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations
	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "bounce_auth_user_id", "full_name", "email",
		"created_at", "updated_at", "display_name", "profile_photo",
	}).
		AddRow("user-123", "auth-123", "Test User", "test@example.com", now, now, "TU", "")

	mock.ExpectQuery("SELECT (.+) FROM \"user\" WHERE id").
		WithArgs("user-123").
		WillReturnRows(rows)

	// Execute
	user, err := client.GetUser("user-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify
	if user == nil {
		t.Fatal("expected user, got nil")
	}

	if user.ID != "user-123" {
		t.Errorf("expected user-123, got %s", user.ID)
	}

	if user.FullName == nil || *user.FullName != "Test User" {
		if user.FullName == nil {
			t.Error("expected FullName 'Test User', got nil")
		} else {
			t.Errorf("expected 'Test User', got %s", *user.FullName)
		}
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestGetUser_NotFound(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations for no rows
	mock.ExpectQuery("SELECT (.+) FROM \"user\" WHERE id").
		WithArgs("user-999").
		WillReturnError(sql.ErrNoRows)

	// Execute
	user, err := client.GetUser("user-999")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify
	if user != nil {
		t.Error("expected nil user for not found, got non-nil")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestGetUser_QueryError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	// Setup expectations for error
	mock.ExpectQuery("SELECT (.+) FROM \"user\" WHERE id").
		WithArgs("user-123").
		WillReturnError(fmt.Errorf("database connection lost"))

	// Execute
	_, err = client.GetUser("user-123")
	if err == nil {
		t.Error("expected error, got nil")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestClose_WithConnection(t *testing.T) {
	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}

	client := &Client{
		db: sqlx.NewDb(mockDB, "sqlmock"),
	}

	// Setup expectations
	mock.ExpectClose()

	// Execute
	err = client.Close()
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestClose_WithNilConnection(t *testing.T) {
	client := &Client{
		db: nil,
	}

	// Execute
	err := client.Close()
	if err != nil {
		t.Errorf("unexpected error with nil connection: %v", err)
	}
}

func TestHealth_Success(t *testing.T) {
	mockDB, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db: sqlx.NewDb(mockDB, "sqlmock"),
	}

	// Setup expectations
	mock.ExpectPing()

	// Execute
	err = client.Health()
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestHealth_NilConnection(t *testing.T) {
	client := &Client{
		db: nil,
	}

	// Execute
	err := client.Health()
	if err == nil {
		t.Error("expected error for nil connection, got nil")
	}

	expectedMsg := "database connection not initialized"
	if err.Error() != expectedMsg {
		t.Errorf("expected error '%s', got '%s'", expectedMsg, err.Error())
	}
}

func TestHealth_PingError(t *testing.T) {
	mockDB, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db: sqlx.NewDb(mockDB, "sqlmock"),
	}

	// Setup expectations
	mock.ExpectPing().WillReturnError(fmt.Errorf("connection refused"))

	// Execute
	err = client.Health()
	if err == nil {
		t.Error("expected error, got nil")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
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

func TestGetUsers_Pagination(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create mock: %v", err)
	}
	defer func() { _ = mockDB.Close() }()

	client := &Client{
		db:     sqlx.NewDb(mockDB, "sqlmock"),
		logger: logger,
	}

	now := time.Now()

	// First page
	rows1 := sqlmock.NewRows([]string{
		"id", "bounce_auth_user_id", "full_name", "email",
		"created_at", "updated_at", "display_name", "profile_photo",
	}).
		AddRow("user-1", "auth-1", "User One", "user1@example.com", now, now, "U1", "").
		AddRow("user-2", "auth-2", "User Two", "user2@example.com", now, now, "U2", "")

	mock.ExpectQuery("SELECT (.+) FROM \"user\"").
		WithArgs("", 2).
		WillReturnRows(rows1)

	// Second page (after user-2)
	rows2 := sqlmock.NewRows([]string{
		"id", "bounce_auth_user_id", "full_name", "email",
		"created_at", "updated_at", "display_name", "profile_photo",
	}).
		AddRow("user-3", "auth-3", "User Three", "user3@example.com", now, now, "U3", "")

	mock.ExpectQuery("SELECT (.+) FROM \"user\"").
		WithArgs("user-2", 2).
		WillReturnRows(rows2)

	// Execute first page
	users1, err := client.GetUsers(context.Background(), 2, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(users1) != 2 {
		t.Errorf("expected 2 users on first page, got %d", len(users1))
	}

	// Execute second page
	users2, err := client.GetUsers(context.Background(), 2, "user-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(users2) != 1 {
		t.Errorf("expected 1 user on second page, got %d", len(users2))
	}
	if users2[0].ID != "user-3" {
		t.Errorf("expected user-3, got %s", users2[0].ID)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}
