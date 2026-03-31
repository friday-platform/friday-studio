package service

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tempestteam/atlas/apps/persona/repo"
)

// TestRLSUserAccess tests that RLS policies enforce user access control
// at the database level for persona user queries.
//
// Prerequisites:
//   - Test database with RLS migrations applied
//   - User table with RLS policies
//   - POSTGRES_CONNECTION env var set
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres" go test -v -run TestRLSUserAccess
func TestRLSUserAccess(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()

	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("Failed to ping database: %v", err)
	}

	userA := "test-persona-user-a"
	userB := "test-persona-user-b"

	// Setup: Create test users
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email, display_name, profile_photo)
		VALUES ($1, 'Persona User A', 'personaa@test.com', 'personaa', '')
		ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name
	`, userA)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user A: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email, display_name, profile_photo)
		VALUES ($1, 'Persona User B', 'personab@test.com', 'personab', '')
		ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name
	`, userB)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user B: %v", err)
	}
	conn.Release()

	// Cleanup
	defer func() {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Test: User A can read their own profile
	t.Run("UserACanReadOwnProfile", func(t *testing.T) {
		user, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (repo.GetUserByIDRow, error) {
			return q.GetUserByID(ctx, userA)
		})
		if err != nil {
			t.Fatalf("User A should be able to read their profile: %v", err)
		}
		if user.ID != userA {
			t.Errorf("Expected user ID %q, got %q", userA, user.ID)
		}
		if user.FullName != "Persona User A" {
			t.Errorf("Expected full_name %q, got %q", "Persona User A", user.FullName)
		}
	})

	// Test: User B can read their own profile
	t.Run("UserBCanReadOwnProfile", func(t *testing.T) {
		user, err := withUserContextReadPool(ctx, pool, userB, func(q *repo.Queries) (repo.GetUserByIDRow, error) {
			return q.GetUserByID(ctx, userB)
		})
		if err != nil {
			t.Fatalf("User B should be able to read their profile: %v", err)
		}
		if user.ID != userB {
			t.Errorf("Expected user ID %q, got %q", userB, user.ID)
		}
	})

	// Test: User A cannot read User B's profile (RLS should block)
	t.Run("UserACannotReadUserBProfile", func(t *testing.T) {
		_, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (repo.GetUserByIDRow, error) {
			return q.GetUserByID(ctx, userB) // Try to read User B's profile
		})
		// RLS should prevent this - query should return no rows
		if err == nil {
			t.Error("User A should not be able to read User B's profile - RLS policy may not be enforced")
		}
	})

	// Test: Query without user context returns nothing
	t.Run("NoUserContextReturnsNothing", func(t *testing.T) {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("Failed to acquire connection: %v", err)
		}
		defer conn.Release()

		tx, err := conn.Begin(ctx)
		if err != nil {
			t.Fatalf("Failed to begin transaction: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()

		_, err = tx.Exec(ctx, "SET LOCAL ROLE authenticated")
		if err != nil {
			t.Fatalf("Failed to set role: %v", err)
		}

		// Intentionally NOT setting request.user_id
		q := repo.New(tx)
		_, err = q.GetUserByID(ctx, userA)

		// Should fail because request.user_id is not set
		if err == nil {
			t.Error("Query without user context should not return data")
		}
	})
}

// TestRLSUserUpdate tests that RLS policies enforce user isolation for UPDATE
// operations on the public.user table.
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres" go test -v -run TestRLSUserUpdate
func TestRLSUserUpdate(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()

	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	userA := "test-persona-update-a"
	userB := "test-persona-update-b"

	// Setup: Create test users
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email, display_name, profile_photo)
		VALUES ($1, 'Update User A', 'updatepersonaa@test.com', 'updatea', '')
		ON CONFLICT (id) DO UPDATE SET full_name = 'Update User A', display_name = 'updatea', profile_photo = ''
	`, userA)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user A: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email, display_name, profile_photo)
		VALUES ($1, 'Update User B', 'updatepersonab@test.com', 'updateb', '')
		ON CONFLICT (id) DO UPDATE SET full_name = 'Update User B', display_name = 'updateb', profile_photo = ''
	`, userB)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user B: %v", err)
	}
	conn.Release()

	defer func() {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Test: User A can update their own profile
	t.Run("UserACanUpdateOwnProfile", func(t *testing.T) {
		updated, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (repo.UpdateUserRow, error) {
			return q.UpdateUser(ctx, repo.UpdateUserParams{
				ID:       userA,
				FullName: pgtype.Text{String: "Updated Name A", Valid: true},
			})
		})
		if err != nil {
			t.Fatalf("User A should be able to update their profile: %v", err)
		}
		if updated.FullName != "Updated Name A" {
			t.Errorf("FullName = %q, want %q", updated.FullName, "Updated Name A")
		}
		// display_name should be preserved (COALESCE with NULL keeps current)
		if updated.DisplayName != "updatea" {
			t.Errorf("DisplayName = %q, want %q (should be preserved)", updated.DisplayName, "updatea")
		}
	})

	// Test: User B cannot update User A's profile (RLS blocks)
	t.Run("UserBCannotUpdateUserAProfile", func(t *testing.T) {
		_, err := withUserContextReadPool(ctx, pool, userB, func(q *repo.Queries) (repo.UpdateUserRow, error) {
			return q.UpdateUser(ctx, repo.UpdateUserParams{
				ID:       userA, // User B tries to update User A
				FullName: pgtype.Text{String: "Hacked Name", Valid: true},
			})
		})
		// RLS should block this — UPDATE WHERE matches 0 rows, RETURNING gives no rows
		if err == nil {
			t.Error("User B should not be able to update User A's profile")
		}

		// Verify User A's name was NOT changed
		user, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (repo.GetUserByIDRow, error) {
			return q.GetUserByID(ctx, userA)
		})
		if err != nil {
			t.Fatalf("Failed to read User A: %v", err)
		}
		if user.FullName == "Hacked Name" {
			t.Error("User A's name was changed by User B — RLS policy is not enforced")
		}
	})
}

// TestRLSConnectionPoolSafety verifies that SET LOCAL ROLE and set_config
// don't leak between transactions when connections are reused from the pool.
func TestRLSConnectionPoolSafety(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Use small pool to force connection reuse
	pool.Config().MaxConns = 1

	userA := "pool-persona-user-a"

	// Setup test user
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email, display_name, profile_photo)
		VALUES ($1, 'Pool User A', 'poolpersonaa@test.com', 'poolpersonaa', '')
		ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name
	`, userA)
	conn.Release()

	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id = $1`, userA)
	}()

	// Transaction 1: Query with User A context
	_, err = withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (repo.GetUserByIDRow, error) {
		return q.GetUserByID(ctx, userA)
	})
	if err != nil {
		t.Fatalf("Failed to query user A: %v", err)
	}

	// Transaction 2: Verify connection doesn't retain User A's context
	conn, _ = pool.Acquire(ctx)
	tx, _ := conn.Begin(ctx)
	_, _ = tx.Exec(ctx, "SET LOCAL ROLE authenticated")
	// Intentionally NOT setting request.user_id

	var userID string
	_ = tx.QueryRow(ctx, "SELECT current_setting('request.user_id', true)").Scan(&userID)
	_ = tx.Rollback(ctx)
	conn.Release()

	if userID != "" {
		t.Errorf("request.user_id leaked from previous transaction: got %q, want empty", userID)
	}
}

// withUserContextPool is like withUserContext but takes pool directly (for tests).
func withUserContextPool(ctx context.Context, pool *pgxpool.Pool, userID string, fn func(*repo.Queries) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, "SET LOCAL ROLE authenticated")
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, "SELECT set_config('request.user_id', $1, true)", userID)
	if err != nil {
		return err
	}

	if err := fn(repo.New(tx)); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// withUserContextReadPool is like withUserContextRead but takes pool directly (for tests).
func withUserContextReadPool[T any](ctx context.Context, pool *pgxpool.Pool, userID string, fn func(*repo.Queries) (T, error)) (T, error) {
	var result T
	err := withUserContextPool(ctx, pool, userID, func(q *repo.Queries) error {
		var err error
		result, err = fn(q)
		return err
	})
	return result, err
}
