package service

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/apps/cortex/repo"
)

// TestRLSUserIsolation tests that RLS policies enforce user isolation
// at the database level for cortex objects.
//
// Prerequisites:
//   - Test database with RLS migrations applied
//   - Migration 20251223000000_create_cortex_schema.sql applied
//   - POSTGRES_CONNECTION env var set
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres" go test -v -run TestRLSUserIsolation
func TestRLSUserIsolation(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	if os.Getenv("SKIP_RLS_TEST") != "" {
		t.Skip("Skipping RLS test: SKIP_RLS_TEST is set")
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

	userA := "test-cortex-user-a"
	userB := "test-cortex-user-b"

	// Pre-test cleanup: remove any leftover data from previous runs
	cleanupTestObjects(pool, userA, userB)

	// Setup: Create test users in public.user (FK constraint)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Cortex User A', 'cortexa@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userA)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user A: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Cortex User B', 'cortexb@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userB)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user B: %v", err)
	}
	conn.Release()

	// Cleanup
	defer cleanupTestObjects(pool, userA, userB)
	defer func() {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Create object for user A
	var objectAID string
	t.Run("CreateObjectUserA", func(t *testing.T) {
		pgID, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (any, error) {
			return q.CreateObject(ctx, repo.CreateObjectParams{
				UserID:   userA,
				Metadata: []byte(`{"test": "user-a"}`),
			})
		})
		if err != nil {
			t.Fatalf("Failed to create object for user A: %v", err)
		}
		objectAID = pgID.(interface{ String() string }).String()
		t.Logf("Created object for user A: %s", objectAID)
	})

	// Create object for user B
	var objectBID string
	t.Run("CreateObjectUserB", func(t *testing.T) {
		pgID, err := withUserContextReadPool(ctx, pool, userB, func(q *repo.Queries) (any, error) {
			return q.CreateObject(ctx, repo.CreateObjectParams{
				UserID:   userB,
				Metadata: []byte(`{"test": "user-b"}`),
			})
		})
		if err != nil {
			t.Fatalf("Failed to create object for user B: %v", err)
		}
		objectBID = pgID.(interface{ String() string }).String()
		t.Logf("Created object for user B: %s", objectBID)
	})

	// Test: User A can access their own object
	t.Run("UserACanAccessOwnObject", func(t *testing.T) {
		objects, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (any, error) {
			return q.ListObjects(ctx, repo.ListObjectsParams{UserID: userA, Limit: 100, Offset: 0})
		})
		if err != nil {
			t.Fatalf("User A should be able to list their objects: %v", err)
		}
		list := objects.([]repo.CortexObject)
		if len(list) != 1 {
			t.Errorf("Expected 1 object for user A, got %d", len(list))
		}
		if list[0].UserID != userA {
			t.Errorf("Expected user_id=%q, got %q", userA, list[0].UserID)
		}
	})

	// Test: User A cannot see User B's objects in list
	t.Run("UserACannotSeeUserBObjects", func(t *testing.T) {
		// User A lists objects - should only see their own
		objects, err := withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (any, error) {
			// Try to list with user B's ID - RLS should still filter to user A
			return q.ListObjects(ctx, repo.ListObjectsParams{UserID: userB, Limit: 100, Offset: 0})
		})
		if err != nil {
			t.Fatalf("List query failed: %v", err)
		}
		list := objects.([]repo.CortexObject)
		// RLS restricts to current user, so even querying for userB returns nothing
		if len(list) != 0 {
			t.Errorf("User A should not see user B's objects, got %d objects", len(list))
		}
	})

	// Test: User B can only access their own object
	t.Run("UserBCanAccessOwnObject", func(t *testing.T) {
		objects, err := withUserContextReadPool(ctx, pool, userB, func(q *repo.Queries) (any, error) {
			return q.ListObjects(ctx, repo.ListObjectsParams{UserID: userB, Limit: 100, Offset: 0})
		})
		if err != nil {
			t.Fatalf("User B should be able to list their objects: %v", err)
		}
		list := objects.([]repo.CortexObject)
		if len(list) != 1 {
			t.Errorf("Expected 1 object for user B, got %d", len(list))
		}
	})

	// Test: User A cannot update User B's object
	t.Run("UserACannotUpdateUserBObject", func(t *testing.T) {
		// Get User B's object ID as pgtype.UUID
		conn, _ := pool.Acquire(ctx)
		var objectBPgID pgtype.UUID
		err := conn.QueryRow(ctx, "SELECT id FROM cortex.object WHERE user_id = $1", userB).Scan(&objectBPgID)
		conn.Release()
		if err != nil {
			t.Fatalf("Failed to get user B's object ID: %v", err)
		}

		// User A tries to update User B's metadata
		// The update should succeed but affect 0 rows (RLS blocks it)
		_ = withUserContextPool(ctx, pool, userA, func(q *repo.Queries) error {
			return q.UpdateMetadata(ctx, repo.UpdateMetadataParams{
				ID:       objectBPgID,
				Metadata: []byte(`{"hacked": true}`),
			})
		})
		// We verify by checking the metadata wasn't changed
		conn, _ = pool.Acquire(ctx)
		var metadata []byte
		_ = conn.QueryRow(ctx, "SELECT metadata FROM cortex.object WHERE user_id = $1", userB).Scan(&metadata)
		conn.Release()

		if string(metadata) == `{"hacked": true}` {
			t.Error("User A was able to update User B's object - RLS FAILED!")
		}
	})

	// Test: User A cannot delete User B's object
	t.Run("UserACannotDeleteUserBObject", func(t *testing.T) {
		// Get User B's object ID
		conn, _ := pool.Acquire(ctx)
		var objectBPgID pgtype.UUID
		err := conn.QueryRow(ctx, "SELECT id FROM cortex.object WHERE user_id = $1 AND deleted_at IS NULL", userB).Scan(&objectBPgID)
		conn.Release()
		if err != nil {
			t.Fatalf("Failed to get user B's object ID: %v", err)
		}

		// User A tries to delete User B's object
		_ = withUserContextPool(ctx, pool, userA, func(q *repo.Queries) error {
			return q.DeleteObject(ctx, objectBPgID)
		})

		// Verify User B's object still exists
		conn, _ = pool.Acquire(ctx)
		var count int
		_ = conn.QueryRow(ctx, "SELECT COUNT(*) FROM cortex.object WHERE user_id = $1 AND deleted_at IS NULL", userB).Scan(&count)
		conn.Release()

		if count != 1 {
			t.Errorf("User A was able to delete User B's object - RLS FAILED! count=%d", count)
		}
	})

	// Test: Queries without request.user_id return no results
	t.Run("NoUserContextReturnsNothing", func(t *testing.T) {
		assertNoAccessWithoutUserContext(t, pool, func(q *repo.Queries) error {
			objects, err := q.ListObjects(ctx, repo.ListObjectsParams{UserID: userA, Limit: 100, Offset: 0})
			if err != nil {
				return err
			}
			if len(objects) > 0 {
				t.Error("Query without user context returned objects")
			}
			return nil
		})
	})

	// Cleanup: User A deletes their own object (should work)
	t.Run("UserACanDeleteOwnObject", func(t *testing.T) {
		conn, _ := pool.Acquire(ctx)
		var objectAPgID pgtype.UUID
		err := conn.QueryRow(ctx, "SELECT id FROM cortex.object WHERE user_id = $1 AND deleted_at IS NULL", userA).Scan(&objectAPgID)
		conn.Release()
		if err != nil {
			t.Skipf("User A's object not found (may have been cleaned up): %v", err)
		}

		err = withUserContextPool(ctx, pool, userA, func(q *repo.Queries) error {
			return q.DeleteObject(ctx, objectAPgID)
		})
		if err != nil {
			t.Errorf("User A should be able to delete their own object: %v", err)
		}
	})

	_ = objectAID
	_ = objectBID
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

	userA := "pool-cortex-user-a"
	userB := "pool-cortex-user-b"

	// Setup test users
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, `INSERT INTO public."user" (id, full_name, email) VALUES ($1, 'A', 'poolcortexa@test.com') ON CONFLICT DO NOTHING`, userA)
	_, _ = conn.Exec(ctx, `INSERT INTO public."user" (id, full_name, email) VALUES ($1, 'B', 'poolcortexb@test.com') ON CONFLICT DO NOTHING`, userB)
	conn.Release()

	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM cortex.object WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Create object for user A
	_, err = withUserContextReadPool(ctx, pool, userA, func(q *repo.Queries) (any, error) {
		return q.CreateObject(ctx, repo.CreateObjectParams{
			UserID:   userA,
			Metadata: []byte(`{}`),
		})
	})
	if err != nil {
		t.Fatalf("Failed to create object for user A: %v", err)
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

	// Transaction 3: User B should not see User A's objects
	objects, err := withUserContextReadPool(ctx, pool, userB, func(q *repo.Queries) (any, error) {
		return q.ListObjects(ctx, repo.ListObjectsParams{UserID: userA, Limit: 100, Offset: 0})
	})
	if err != nil {
		t.Fatalf("List query failed: %v", err)
	}
	list := objects.([]repo.CortexObject)
	if len(list) > 0 {
		t.Error("User B saw User A's objects - context leaked!")
	}
}

// cleanupTestObjects removes test objects from the database.
func cleanupTestObjects(pool *pgxpool.Pool, userIDs ...string) {
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return
	}
	defer conn.Release()

	// Disable soft_delete trigger to allow hard deletes
	_, _ = conn.Exec(ctx, "ALTER TABLE cortex.object DISABLE TRIGGER object_soft_delete")
	defer func() {
		_, _ = conn.Exec(ctx, "ALTER TABLE cortex.object ENABLE TRIGGER object_soft_delete")
	}()

	for _, userID := range userIDs {
		_, _ = conn.Exec(ctx, "DELETE FROM cortex.object WHERE user_id = $1", userID)
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
func withUserContextReadPool(ctx context.Context, pool *pgxpool.Pool, userID string, fn func(*repo.Queries) (any, error)) (any, error) {
	var result any
	err := withUserContextPool(ctx, pool, userID, func(q *repo.Queries) error {
		var err error
		result, err = fn(q)
		return err
	})
	return result, err
}

// assertNoAccessWithoutUserContext verifies that queries fail when request.user_id is not set.
func assertNoAccessWithoutUserContext(t *testing.T, pool *pgxpool.Pool, queryFn func(*repo.Queries) error) {
	t.Helper()
	ctx := context.Background()

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
	// Query should fail or return nothing - we just verify it doesn't panic
	_ = queryFn(repo.New(tx))
}
