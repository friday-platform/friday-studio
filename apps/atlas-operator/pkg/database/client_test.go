package database

import (
	"context"
	"log/slog"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/phuslu/lru"
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

// fakeRow implements pgx.Row for HasVirtualKey tests.
type fakeRow struct {
	exists bool
}

func (r *fakeRow) Scan(dest ...any) error {
	if len(dest) > 0 {
		if p, ok := dest[0].(*bool); ok {
			*p = r.exists
		}
	}
	return nil
}

// fakeDBTX implements repo.DBTX, tracking QueryRow calls.
type fakeDBTX struct {
	hasKeyResult bool
	queryCount   atomic.Int64
}

func (f *fakeDBTX) Exec(_ context.Context, _ string, _ ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag(""), nil
}

func (f *fakeDBTX) Query(_ context.Context, _ string, _ ...interface{}) (pgx.Rows, error) {
	return nil, nil
}

func (f *fakeDBTX) QueryRow(_ context.Context, _ string, _ ...interface{}) pgx.Row {
	f.queryCount.Add(1)
	return &fakeRow{exists: f.hasKeyResult}
}

func newTestClient(db *fakeDBTX) *Client {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	return &Client{
		queries:         repo.New(db),
		logger:          logger,
		virtualKeyCache: lru.NewTTLCache[string, struct{}](128),
	}
}

func TestHasVirtualKey_CacheHit(t *testing.T) {
	db := &fakeDBTX{hasKeyResult: true}
	client := newTestClient(db)
	ctx := context.Background()

	// First call: cache miss, hits DB
	got, err := client.HasVirtualKey(ctx, "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Fatal("expected true, got false")
	}
	if db.queryCount.Load() != 1 {
		t.Fatalf("expected 1 DB call, got %d", db.queryCount.Load())
	}

	// Second call: cache hit, no additional DB call
	got, err = client.HasVirtualKey(ctx, "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Fatal("expected true from cache, got false")
	}
	if db.queryCount.Load() != 1 {
		t.Fatalf("expected still 1 DB call after cache hit, got %d", db.queryCount.Load())
	}
}

func TestHasVirtualKey_FalseNotCached(t *testing.T) {
	db := &fakeDBTX{hasKeyResult: false}
	client := newTestClient(db)
	ctx := context.Background()

	// First call: returns false, should NOT cache
	got, err := client.HasVirtualKey(ctx, "user-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got {
		t.Fatal("expected false, got true")
	}

	// Second call: should still hit DB (false was not cached)
	_, _ = client.HasVirtualKey(ctx, "user-2")
	if db.queryCount.Load() != 2 {
		t.Fatalf("expected 2 DB calls (false not cached), got %d", db.queryCount.Load())
	}
}

func TestDeleteVirtualKey_InvalidatesCache(t *testing.T) {
	db := &fakeDBTX{hasKeyResult: true}
	client := newTestClient(db)
	ctx := context.Background()

	// First, populate cache via HasVirtualKey
	got, err := client.HasVirtualKey(ctx, "user-del")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Fatal("expected true, got false")
	}

	// Cache should be populated — verify no extra DB call
	before := db.queryCount.Load()
	got, err = client.HasVirtualKey(ctx, "user-del")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Fatal("expected true from cache")
	}
	if db.queryCount.Load() != before {
		t.Fatal("expected no DB call for cached entry")
	}

	// Delete the key — should invalidate cache
	err = client.DeleteVirtualKey(ctx, "user-del")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Now HasVirtualKey should hit DB again (cache invalidated)
	// fakeDBTX still returns true, but the point is it hits the DB
	before = db.queryCount.Load()
	_, _ = client.HasVirtualKey(ctx, "user-del")
	if db.queryCount.Load() != before+1 {
		t.Fatal("expected DB call after cache invalidation")
	}
}

func TestHasVirtualKey_InsertPopulatesCache(t *testing.T) {
	db := &fakeDBTX{hasKeyResult: false}
	client := newTestClient(db)
	ctx := context.Background()

	// Insert populates cache
	err := client.InsertVirtualKey(ctx, "user-3", []byte("ciphertext"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// HasVirtualKey should return true from cache without hitting DB for HasVirtualKey query.
	// Reset counter after insert (which used Exec, not QueryRow, but let's be explicit).
	before := db.queryCount.Load()
	got, err := client.HasVirtualKey(ctx, "user-3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Fatal("expected true after insert, got false")
	}
	if db.queryCount.Load() != before {
		t.Fatalf("expected no additional DB query after InsertVirtualKey cache population, got %d new calls", db.queryCount.Load()-before)
	}
}
