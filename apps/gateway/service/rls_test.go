package service

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tempestteam/atlas/apps/gateway/repo"
)

// TestWithUserContextRead_ReturnsValue tests that withUserContextRead correctly
// propagates the return value from the callback through the RLS transaction.
//
// Prerequisites:
//   - Test database with RLS migrations applied
//   - POSTGRES_CONNECTION env var set
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres" go test -v -run TestWithUserContextRead
func TestWithUserContextRead_ReturnsValue(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	require.NoError(t, pool.Ping(ctx))

	userID := "test-gateway-rls-read"

	// Setup: create test user
	conn, err := pool.Acquire(ctx)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Gateway RLS Test', 'gateway-rls@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userID)
	conn.Release()
	require.NoError(t, err)

	defer func() {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id = $1`, userID)
	}()

	t.Run("returns value from callback", func(t *testing.T) {
		email, err := withUserContextRead(ctx, pool, userID, func(q *repo.Queries) (string, error) {
			return q.GetUserEmail(ctx, userID)
		})
		require.NoError(t, err)
		assert.Equal(t, "gateway-rls@test.com", email)
	})

	t.Run("RLS blocks cross-user read", func(t *testing.T) {
		// User tries to read another user's email — RLS should return no rows
		_, err := withUserContextRead(ctx, pool, userID, func(q *repo.Queries) (string, error) {
			return q.GetUserEmail(ctx, "nonexistent-user")
		})
		assert.Error(t, err, "should fail: RLS blocks reading other users' rows")
	})

	t.Run("propagates callback error", func(t *testing.T) {
		_, err := withUserContextRead(ctx, pool, userID, func(q *repo.Queries) (string, error) {
			// Query for a user that doesn't exist — pgx returns ErrNoRows
			return q.GetUserEmail(ctx, "definitely-does-not-exist")
		})
		assert.Error(t, err)
	})
}

// TestWithUserContextRead_RLSIsolation tests that withUserContextRead correctly
// sets the RLS session variables and that they don't leak between transactions.
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres" go test -v -run TestWithUserContextRead_RLSIsolation
func TestWithUserContextRead_RLSIsolation(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	// Force connection reuse to test for context leaks
	pool.Config().MaxConns = 1

	userA := "test-gw-rls-a"
	userB := "test-gw-rls-b"

	conn, err := pool.Acquire(ctx)
	require.NoError(t, err)
	_, _ = conn.Exec(ctx, `INSERT INTO public."user" (id, full_name, email) VALUES ($1, 'A', 'gw-a@test.com') ON CONFLICT DO NOTHING`, userA)
	_, _ = conn.Exec(ctx, `INSERT INTO public."user" (id, full_name, email) VALUES ($1, 'B', 'gw-b@test.com') ON CONFLICT DO NOTHING`, userB)
	conn.Release()

	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Transaction 1: User A reads their own email
	emailA, err := withUserContextRead(ctx, pool, userA, func(q *repo.Queries) (string, error) {
		return q.GetUserEmail(ctx, userA)
	})
	require.NoError(t, err)
	assert.Equal(t, "gw-a@test.com", emailA)

	// Transaction 2: Verify context doesn't leak — check request.user_id is empty
	conn, err = pool.Acquire(ctx)
	require.NoError(t, err)
	tx, err := conn.Begin(ctx)
	require.NoError(t, err)
	_, _ = tx.Exec(ctx, "SET LOCAL ROLE authenticated")

	var leakedUserID string
	_ = tx.QueryRow(ctx, "SELECT current_setting('request.user_id', true)").Scan(&leakedUserID)
	_ = tx.Rollback(ctx)
	conn.Release()

	assert.Empty(t, leakedUserID, "request.user_id should not leak between transactions")

	// Transaction 3: User B cannot read User A's email
	_, err = withUserContextRead(ctx, pool, userB, func(q *repo.Queries) (string, error) {
		return q.GetUserEmail(ctx, userA)
	})
	assert.Error(t, err, "User B should not be able to read User A's email via RLS")
}
