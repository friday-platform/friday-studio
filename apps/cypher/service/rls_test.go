package service

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/apps/cypher/kms"
	"github.com/tempestteam/atlas/apps/cypher/repo"
)

// TestRLSUserIsolation tests that RLS policies enforce user isolation
// at the database level.
//
// Prerequisites:
//   - Test database with RLS migrations applied
//   - Migration 20251218000000_add_rls_policies_cypher_keyset.sql applied
//   - POSTGRES_CONNECTION env var set
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres?search_path=cypher" go test -v -run TestRLSUserIsolation
func TestRLSUserIsolation(t *testing.T) {
	// Skip if not running integration tests
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	// Skip if explicitly disabled (e.g., when RLS migrations not applied)
	if os.Getenv("SKIP_RLS_TEST") != "" {
		t.Skip("Skipping RLS test: SKIP_RLS_TEST is set (likely using service role)")
	}

	ctx := context.Background()

	// Setup database connection
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Verify connection
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("Failed to ping database: %v", err)
	}

	fakeKMS := kms.NewFakeKMS()
	cache := NewKeyCache(pool, fakeKMS, 100)

	// Create test user IDs
	userA := "test-user-a-rls-isolation"
	userB := "test-user-b-rls-isolation"

	// Setup: Create test users in public.user (FK constraint)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Test User A', 'keyseta@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userA)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user A: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Test User B', 'keysetb@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userB)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user B: %v", err)
	}
	conn.Release()

	// Cleanup any existing test data
	defer cleanupTestKeysets(pool, userA, userB)
	defer func() {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Test 1: Create keyset for user A
	t.Run("CreateKeysetUserA", func(t *testing.T) {
		aeadA, err := cache.GetAEAD(ctx, userA)
		if err != nil {
			t.Fatalf("Failed to create keyset for user A: %v", err)
		}
		if aeadA == nil {
			t.Fatal("AEAD for user A is nil")
		}
	})

	// Test 2: Create keyset for user B
	t.Run("CreateKeysetUserB", func(t *testing.T) {
		aeadB, err := cache.GetAEAD(ctx, userB)
		if err != nil {
			t.Fatalf("Failed to create keyset for user B: %v", err)
		}
		if aeadB == nil {
			t.Fatal("AEAD for user B is nil")
		}
	})

	// Test 3: Verify user A can only see their own keyset
	t.Run("UserACanOnlyAccessOwnKeyset", func(t *testing.T) {
		// Query for user A's keyset with user A context
		rowA, err := withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) (*repo.CypherKeyset, error) {
			return queries.GetKeysetByUserID(ctx, userA)
		})
		if err != nil {
			t.Fatalf("User A should be able to access their own keyset: %v", err)
		}
		if rowA.UserID != userA {
			t.Errorf("Expected user_id=%q, got %q", userA, rowA.UserID)
		}

		// User A tries to access User B's keyset - RLS should block it
		_, err = withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) (*repo.CypherKeyset, error) {
			return queries.GetKeysetByUserID(ctx, userB)
		})
		if err == nil {
			t.Error("User A should NOT be able to access user B's keyset via RLS")
		}
	})

	// Test 4: Verify user B can only see their own keyset
	t.Run("UserBCanOnlyAccessOwnKeyset", func(t *testing.T) {
		// Query for user B's keyset with user B context
		rowB, err := withUserContextRead(ctx, pool, userB, func(queries *repo.Queries) (*repo.CypherKeyset, error) {
			return queries.GetKeysetByUserID(ctx, userB)
		})
		if err != nil {
			t.Fatalf("User B should be able to access their own keyset: %v", err)
		}
		if rowB.UserID != userB {
			t.Errorf("Expected user_id=%q, got %q", userB, rowB.UserID)
		}
	})

	// Test 5: Verify queries without request.user_id return no results
	t.Run("NoUserContextReturnsNothing", func(t *testing.T) {
		assertNoAccessWithoutUserContext(t, pool, func(q *repo.Queries) error {
			_, err := q.GetKeysetByUserID(ctx, userA)
			return err
		})
	})

	// Test 6: Verify cached AEAD primitives are different for different users
	t.Run("DifferentUsersHaveDifferentKeys", func(t *testing.T) {
		aeadA, err := cache.GetAEAD(ctx, userA)
		if err != nil {
			t.Fatalf("Failed to get AEAD for user A: %v", err)
		}

		aeadB, err := cache.GetAEAD(ctx, userB)
		if err != nil {
			t.Fatalf("Failed to get AEAD for user B: %v", err)
		}

		// Encrypt same plaintext with both keys
		plaintext := []byte("test message")
		aadA := []byte(userA)
		aadB := []byte(userB)

		ciphertextA, err := aeadA.Encrypt(plaintext, aadA)
		if err != nil {
			t.Fatalf("Failed to encrypt with user A's key: %v", err)
		}

		ciphertextB, err := aeadB.Encrypt(plaintext, aadB)
		if err != nil {
			t.Fatalf("Failed to encrypt with user B's key: %v", err)
		}

		// Ciphertexts should be different (different keys)
		if string(ciphertextA) == string(ciphertextB) {
			t.Error("Ciphertexts for different users should be different")
		}

		// User A's ciphertext cannot be decrypted with user B's key
		_, err = aeadB.Decrypt(ciphertextA, aadA)
		if err == nil {
			t.Error("User B should not be able to decrypt user A's ciphertext")
		}

		// User B's ciphertext cannot be decrypted with user A's key
		_, err = aeadA.Decrypt(ciphertextB, aadB)
		if err == nil {
			t.Error("User A should not be able to decrypt user B's ciphertext")
		}
	})
}

// cleanupTestKeysets removes test keysets from the database.
func cleanupTestKeysets(pool *pgxpool.Pool, userIDs ...string) {
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return
	}
	defer conn.Release()

	for _, userID := range userIDs {
		_, _ = conn.Exec(ctx, "DELETE FROM cypher.keyset WHERE user_id = $1", userID)
	}
}

// assertNoAccessWithoutUserContext verifies that queries fail when request.user_id is not set.
// This tests that RLS blocks access when the session variable is missing.
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

	queries := repo.New(tx)
	if err := queryFn(queries); err == nil {
		t.Error("Query without request.user_id should return no rows")
	}
}

// TestRLSUserTableIsolation tests that RLS policies enforce user isolation
// on the public.user table.
//
// Policy: user_self_only - users can only SELECT their own record
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres?search_path=cypher" go test -v -run TestRLSUserTableIsolation
func TestRLSUserTableIsolation(t *testing.T) {
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

	userA := "test-rls-user-a"
	userB := "test-rls-user-b"

	// Setup: Create test users (superuser bypasses RLS)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}

	// Insert test users
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Test User A', 'usera@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userA)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user A: %v", err)
	}

	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Test User B', 'userb@test.com')
		ON CONFLICT (id) DO NOTHING
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

	t.Run("UserCanAccessOwnRecord", func(t *testing.T) {
		row, err := withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) (*repo.GetUserByIDRow, error) {
			return queries.GetUserByID(ctx, userA)
		})
		if err != nil {
			t.Fatalf("User A should be able to access their own record: %v", err)
		}
		if row.ID != userA {
			t.Errorf("Expected id=%q, got %q", userA, row.ID)
		}
		if row.Email != "usera@test.com" {
			t.Errorf("Expected email=%q, got %q", "usera@test.com", row.Email)
		}
	})

	t.Run("UserCannotAccessOtherUserRecord", func(t *testing.T) {
		// User A tries to access User B's record - should fail due to RLS
		_, err := withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) (*repo.GetUserByIDRow, error) {
			return queries.GetUserByID(ctx, userB)
		})
		if err == nil {
			t.Error("User A should NOT be able to access User B's record via RLS")
		}
	})

	t.Run("NoUserContextReturnsNothing", func(t *testing.T) {
		assertNoAccessWithoutUserContext(t, pool, func(q *repo.Queries) error {
			_, err := q.GetUserByID(ctx, userA)
			return err
		})
	})
}

// TestRLSVirtualKeyIsolation tests that RLS policies enforce user isolation
// on the public.llm_virtualkey table.
//
// Policy: llm_virtualkey_user_isolation - users can only SELECT their own virtual key
//
// Run with:
//
//	POSTGRES_CONNECTION="postgresql://postgres:postgres@localhost:54322/postgres?search_path=cypher" go test -v -run TestRLSVirtualKeyIsolation
func TestRLSVirtualKeyIsolation(t *testing.T) {
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

	userA := "test-rls-vkey-user-a"
	userB := "test-rls-vkey-user-b"

	// Setup: Create test users and virtual keys (superuser bypasses RLS)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}

	// Create users first (FK constraint)
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'VKey User A', 'vkeya@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userA)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user A: %v", err)
	}

	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'VKey User B', 'vkeyb@test.com')
		ON CONFLICT (id) DO NOTHING
	`, userB)
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create test user B: %v", err)
	}

	// Create virtual keys
	_, err = conn.Exec(ctx, `
		INSERT INTO public.llm_virtualkey (user_id, ciphertext)
		VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext
	`, userA, []byte("ciphertext-user-a"))
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create virtual key for user A: %v", err)
	}

	_, err = conn.Exec(ctx, `
		INSERT INTO public.llm_virtualkey (user_id, ciphertext)
		VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext
	`, userB, []byte("ciphertext-user-b"))
	if err != nil {
		conn.Release()
		t.Fatalf("Failed to create virtual key for user B: %v", err)
	}
	conn.Release()

	// Cleanup
	defer func() {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public.llm_virtualkey WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	t.Run("UserCanAccessOwnVirtualKey", func(t *testing.T) {
		ciphertext, err := withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) ([]byte, error) {
			return queries.GetVirtualKeyCiphertext(ctx, userA)
		})
		if err != nil {
			t.Fatalf("User A should be able to access their own virtual key: %v", err)
		}
		if string(ciphertext) != "ciphertext-user-a" {
			t.Errorf("Expected ciphertext=%q, got %q", "ciphertext-user-a", string(ciphertext))
		}
	})

	t.Run("UserCannotAccessOtherUserVirtualKey", func(t *testing.T) {
		// User A tries to access User B's virtual key - should fail due to RLS
		_, err := withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) ([]byte, error) {
			return queries.GetVirtualKeyCiphertext(ctx, userB)
		})
		if err == nil {
			t.Error("User A should NOT be able to access User B's virtual key via RLS")
		}
	})

	t.Run("NoUserContextReturnsNothing", func(t *testing.T) {
		assertNoAccessWithoutUserContext(t, pool, func(q *repo.Queries) error {
			_, err := q.GetVirtualKeyCiphertext(ctx, userA)
			return err
		})
	})
}

// TestRLSConnectionPoolSafety verifies that SET LOCAL ROLE and set_config
// don't leak between transactions when connections are reused from the pool.
//
// This is critical for security - if role/user_id leaked, one user could
// access another user's data on a reused connection.
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

	// Use a small pool to force connection reuse
	pool.Config().MaxConns = 1

	userA := "pool-test-user-a"
	userB := "pool-test-user-b"

	// Setup test users
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, `INSERT INTO public."user" (id, full_name, email) VALUES ($1, 'A', 'a@test.com') ON CONFLICT DO NOTHING`, userA)
	_, _ = conn.Exec(ctx, `INSERT INTO public."user" (id, full_name, email) VALUES ($1, 'B', 'b@test.com') ON CONFLICT DO NOTHING`, userB)
	conn.Release()

	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id IN ($1, $2)`, userA, userB)
	}()

	// Transaction 1: User A context
	_, err = withUserContextRead(ctx, pool, userA, func(queries *repo.Queries) (*repo.GetUserByIDRow, error) {
		return queries.GetUserByID(ctx, userA)
	})
	if err != nil {
		t.Fatalf("User A query failed: %v", err)
	}

	// Transaction 2: Verify connection doesn't retain User A's context
	// Query WITHOUT user context should fail (not inherit User A's context)
	conn, _ = pool.Acquire(ctx)
	tx, _ := conn.Begin(ctx)
	_, _ = tx.Exec(ctx, "SET LOCAL ROLE authenticated")
	// Intentionally NOT setting request.user_id - should be empty

	var userID string
	_ = tx.QueryRow(ctx, "SELECT current_setting('request.user_id', true)").Scan(&userID)
	_ = tx.Rollback(ctx)
	conn.Release()

	if userID != "" {
		t.Errorf("request.user_id leaked from previous transaction: got %q, want empty", userID)
	}

	// Transaction 3: User B should only see their own data, not User A's
	_, err = withUserContextRead(ctx, pool, userB, func(queries *repo.Queries) (*repo.GetUserByIDRow, error) {
		// Try to access User A's record with User B's context - should fail
		return queries.GetUserByID(ctx, userA)
	})
	if err == nil {
		t.Error("User B accessed User A's record - context leaked!")
	}
}
