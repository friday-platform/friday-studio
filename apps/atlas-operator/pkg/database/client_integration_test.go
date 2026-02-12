//go:build integration

package database

import (
	"context"
	"log/slog"
	"os"
	"slices"
	"testing"
)

const testDBURL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

func setupIntegrationClient(t *testing.T) *Client {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	client, err := NewClient(testDBURL, logger)
	if err != nil {
		t.Fatalf("failed to connect to test database: %v", err)
	}
	t.Cleanup(func() {
		// Clean up test data
		ctx := context.Background()
		for _, id := range []string{"int-qa-1", "int-qa-2", "int-qa-3", "int-qa-4"} {
			_ = client.DeleteVirtualKey(ctx, id)
		}
		pool := client.pool
		_, _ = pool.Exec(ctx, `DELETE FROM public."user" WHERE id LIKE 'int-qa-%'`)
		_ = client.Close()
	})
	return client
}

func seedTestUsers(t *testing.T, client *Client) {
	t.Helper()
	ctx := context.Background()
	pool := client.pool

	// Create test users
	for _, u := range []struct{ id, email string }{
		{"int-qa-1", "intqa1@test.local"},
		{"int-qa-2", "intqa2@test.local"},
		{"int-qa-3", "intqa3@test.local"},
		{"int-qa-4", "intqa4@test.local"},
	} {
		_, err := pool.Exec(ctx,
			`INSERT INTO public."user" (id, email, full_name, display_name, profile_photo)
			 VALUES ($1, $2, '', '', '')
			 ON CONFLICT (id) DO NOTHING`, u.id, u.email)
		if err != nil {
			t.Fatalf("failed to seed user %s: %v", u.id, err)
		}
	}

	// Give virtual keys to qa-1 and qa-3 only
	for _, uid := range []string{"int-qa-1", "int-qa-3"} {
		err := client.InsertVirtualKey(ctx, uid, []byte("test-ciphertext"))
		if err != nil {
			t.Fatalf("failed to seed virtual key for %s: %v", uid, err)
		}
	}
}

func TestIntegration_GetUserIDsMissingVirtualKeys(t *testing.T) {
	client := setupIntegrationClient(t)
	seedTestUsers(t, client)
	ctx := context.Background()

	t.Run("returns all missing users", func(t *testing.T) {
		missing, err := client.GetUserIDsMissingVirtualKeys(ctx, 1000)
		if err != nil {
			t.Fatalf("GetUserIDsMissingVirtualKeys failed: %v", err)
		}

		// int-qa-2 and int-qa-4 should be missing (they have no keys)
		// int-qa-1 and int-qa-3 should NOT be in the list (they have keys)
		if slices.Contains(missing, "int-qa-1") {
			t.Error("int-qa-1 should NOT be in missing list (has key)")
		}
		if !slices.Contains(missing, "int-qa-2") {
			t.Error("int-qa-2 SHOULD be in missing list (no key)")
		}
		if slices.Contains(missing, "int-qa-3") {
			t.Error("int-qa-3 should NOT be in missing list (has key)")
		}
		if !slices.Contains(missing, "int-qa-4") {
			t.Error("int-qa-4 SHOULD be in missing list (no key)")
		}
	})

	t.Run("limit constrains result count", func(t *testing.T) {
		missing, err := client.GetUserIDsMissingVirtualKeys(ctx, 1)
		if err != nil {
			t.Fatalf("GetUserIDsMissingVirtualKeys failed: %v", err)
		}
		if len(missing) != 1 {
			t.Errorf("expected 1 result with limit=1, got %d: %v", len(missing), missing)
		}
	})
}

func TestIntegration_GetVirtualKeyUserIDs(t *testing.T) {
	client := setupIntegrationClient(t)
	seedTestUsers(t, client)
	ctx := context.Background()

	t.Run("subset with mixed results", func(t *testing.T) {
		// Ask about qa-1 (has key), qa-2 (no key), qa-4 (no key)
		result, err := client.GetVirtualKeyUserIDs(ctx, []string{"int-qa-1", "int-qa-2", "int-qa-4"})
		if err != nil {
			t.Fatalf("GetVirtualKeyUserIDs failed: %v", err)
		}
		if len(result) != 1 {
			t.Fatalf("expected 1 result, got %d: %v", len(result), result)
		}
		if result[0] != "int-qa-1" {
			t.Errorf("expected int-qa-1, got %s", result[0])
		}
	})

	t.Run("all test users", func(t *testing.T) {
		result, err := client.GetVirtualKeyUserIDs(ctx, []string{"int-qa-1", "int-qa-2", "int-qa-3", "int-qa-4"})
		if err != nil {
			t.Fatalf("GetVirtualKeyUserIDs failed: %v", err)
		}
		if len(result) != 2 {
			t.Fatalf("expected 2 results, got %d: %v", len(result), result)
		}
		if !slices.Contains(result, "int-qa-1") || !slices.Contains(result, "int-qa-3") {
			t.Errorf("expected [int-qa-1, int-qa-3], got %v", result)
		}
	})

	t.Run("no matches", func(t *testing.T) {
		result, err := client.GetVirtualKeyUserIDs(ctx, []string{"int-qa-2", "int-qa-4"})
		if err != nil {
			t.Fatalf("GetVirtualKeyUserIDs failed: %v", err)
		}
		if len(result) != 0 {
			t.Errorf("expected 0 results, got %d: %v", len(result), result)
		}
	})

	t.Run("empty input", func(t *testing.T) {
		result, err := client.GetVirtualKeyUserIDs(ctx, []string{})
		if err != nil {
			t.Fatalf("GetVirtualKeyUserIDs failed: %v", err)
		}
		if len(result) != 0 {
			t.Errorf("expected 0 results, got %d: %v", len(result), result)
		}
	})
}

func TestIntegration_DeleteThenMissing(t *testing.T) {
	client := setupIntegrationClient(t)
	seedTestUsers(t, client)
	ctx := context.Background()

	// Delete qa-1's key
	if err := client.DeleteVirtualKey(ctx, "int-qa-1"); err != nil {
		t.Fatalf("DeleteVirtualKey failed: %v", err)
	}

	// Now qa-1 should appear in missing list
	missing, err := client.GetUserIDsMissingVirtualKeys(ctx, 1000)
	if err != nil {
		t.Fatalf("GetUserIDsMissingVirtualKeys failed: %v", err)
	}
	if !slices.Contains(missing, "int-qa-1") {
		t.Error("int-qa-1 SHOULD be in missing list after key deletion")
	}

	// And qa-1 should NOT appear in GetVirtualKeyUserIDs
	result, err := client.GetVirtualKeyUserIDs(ctx, []string{"int-qa-1", "int-qa-3"})
	if err != nil {
		t.Fatalf("GetVirtualKeyUserIDs failed: %v", err)
	}
	if slices.Contains(result, "int-qa-1") {
		t.Error("int-qa-1 should NOT have a virtual key after deletion")
	}
	if !slices.Contains(result, "int-qa-3") {
		t.Error("int-qa-3 SHOULD still have a virtual key")
	}
}

func TestIntegration_InsertThenNotMissing(t *testing.T) {
	client := setupIntegrationClient(t)
	seedTestUsers(t, client)
	ctx := context.Background()

	// qa-2 starts without a key — verify it's missing
	missing, err := client.GetUserIDsMissingVirtualKeys(ctx, 1000)
	if err != nil {
		t.Fatalf("GetUserIDsMissingVirtualKeys failed: %v", err)
	}
	if !slices.Contains(missing, "int-qa-2") {
		t.Fatal("int-qa-2 should be missing before insert")
	}

	// Insert a key for qa-2
	if err := client.InsertVirtualKey(ctx, "int-qa-2", []byte("new-key")); err != nil {
		t.Fatalf("InsertVirtualKey failed: %v", err)
	}

	// Now qa-2 should NOT be in missing list
	missing, err = client.GetUserIDsMissingVirtualKeys(ctx, 1000)
	if err != nil {
		t.Fatalf("GetUserIDsMissingVirtualKeys failed: %v", err)
	}
	if slices.Contains(missing, "int-qa-2") {
		t.Error("int-qa-2 should NOT be in missing list after insert")
	}
}
