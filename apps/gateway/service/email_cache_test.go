package service

import (
	"context"
	"fmt"
	"testing"

	"github.com/phuslu/lru"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsPoolEmail(t *testing.T) {
	tests := []struct {
		email string
		want  bool
	}{
		{"abc123@pool.internal", true},
		{"ABC@POOL.INTERNAL", true},
		{"user@Pool.Internal", true},
		{"user@example.com", false},
		{"user@gmail.com", false},
		{"pool.internal@gmail.com", false},
		{"", false},
		{"@pool.internal", true},
	}

	for _, tt := range tests {
		t.Run(tt.email, func(t *testing.T) {
			assert.Equal(t, tt.want, isPoolEmail(tt.email))
		})
	}
}

func TestEmailCache_Resolve_CacheHit(t *testing.T) {
	calls := 0
	ec := &EmailCache{
		queryFn: func(_ context.Context, _ string) (string, error) {
			calls++
			return "user@example.com", nil
		},
		cache: lru.NewTTLCache[string, string](16),
	}

	ctx := context.Background()

	// First call hits the DB
	email, err := ec.Resolve(ctx, "user-1")
	require.NoError(t, err)
	assert.Equal(t, "user@example.com", email)
	assert.Equal(t, 1, calls)

	// Second call should be a cache hit -- no DB call
	email, err = ec.Resolve(ctx, "user-1")
	require.NoError(t, err)
	assert.Equal(t, "user@example.com", email)
	assert.Equal(t, 1, calls, "expected cache hit, DB should not be called again")
}

func TestEmailCache_Resolve_PoolEmailNotCached(t *testing.T) {
	calls := 0
	ec := &EmailCache{
		queryFn: func(_ context.Context, _ string) (string, error) {
			calls++
			return "abc@pool.internal", nil
		},
		cache: lru.NewTTLCache[string, string](16),
	}

	ctx := context.Background()

	// First call returns pool email, should NOT be cached
	email, err := ec.Resolve(ctx, "user-1")
	require.NoError(t, err)
	assert.Equal(t, "abc@pool.internal", email)
	assert.Equal(t, 1, calls)

	// Second call should hit DB again since pool email was not cached
	email, err = ec.Resolve(ctx, "user-1")
	require.NoError(t, err)
	assert.Equal(t, "abc@pool.internal", email)
	assert.Equal(t, 2, calls, "pool email should not be cached, DB should be called again")
}

func TestEmailCache_Resolve_PoolEmailInCacheBypassesCache(t *testing.T) {
	calls := 0
	ec := &EmailCache{
		queryFn: func(_ context.Context, _ string) (string, error) {
			calls++
			return "real@example.com", nil
		},
		cache: lru.NewTTLCache[string, string](16),
	}

	// Seed cache with a pool email (simulating a race or prior stale state)
	ec.cache.Set("user-1", "abc@pool.internal", 0)

	ctx := context.Background()

	// Should bypass cache because the cached value is a pool email
	email, err := ec.Resolve(ctx, "user-1")
	require.NoError(t, err)
	assert.Equal(t, "real@example.com", email)
	assert.Equal(t, 1, calls, "should re-query DB when cache has pool email")

	// Now cache should have the real email -- no more DB calls
	email, err = ec.Resolve(ctx, "user-1")
	require.NoError(t, err)
	assert.Equal(t, "real@example.com", email)
	assert.Equal(t, 1, calls, "real email should be cached")
}

func TestEmailCache_Resolve_DBError(t *testing.T) {
	ec := &EmailCache{
		queryFn: func(_ context.Context, _ string) (string, error) {
			return "", fmt.Errorf("connection refused")
		},
		cache: lru.NewTTLCache[string, string](16),
	}

	email, err := ec.Resolve(context.Background(), "user-1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "connection refused")
	assert.Empty(t, email)
}
