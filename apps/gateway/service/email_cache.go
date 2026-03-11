package service

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/phuslu/lru"
	"github.com/tempestteam/atlas/apps/gateway/repo"
)

// EmailCache resolves user_id -> email with LRU caching. Pool emails
// (@pool.internal) are never cached because they're transient placeholders
// that get replaced when the user activates their account.
type EmailCache struct {
	queryFn func(ctx context.Context, userID string) (string, error)
	cache   *lru.TTLCache[string, string]
}

// NewEmailCache creates a cache backed by the given connection pool.
// The queryFn uses withUserContextRead + sqlc GetUserEmail for RLS-scoped reads.
func NewEmailCache(pool *pgxpool.Pool, size int) *EmailCache {
	return &EmailCache{
		queryFn: func(ctx context.Context, userID string) (string, error) {
			return withUserContextRead(ctx, pool, userID, func(queries *repo.Queries) (string, error) {
				return queries.GetUserEmail(ctx, userID)
			})
		},
		cache: lru.NewTTLCache[string, string](size),
	}
}

// Resolve returns the current email for a user. It checks the cache first,
// falling back to the database on miss or when the cached value is a pool email.
func (c *EmailCache) Resolve(ctx context.Context, userID string) (string, error) {
	if email, ok := c.cache.Get(userID); ok && !isPoolEmail(email) {
		return email, nil
	}

	email, err := c.queryFn(ctx, userID)
	if err != nil {
		return "", err
	}

	// Only cache real emails -- pool addresses are transient
	if !isPoolEmail(email) {
		c.cache.Set(userID, email, 0)
	}

	return email, nil
}

// isPoolEmail reports whether the email is a pre-provisioned pool placeholder.
func isPoolEmail(email string) bool {
	return strings.HasSuffix(strings.ToLower(email), "@pool.internal")
}

// containsPoolEmail reports whether s contains a @pool.internal reference (case-insensitive).
func containsPoolEmail(s string) bool {
	return strings.Contains(strings.ToLower(s), "@pool.internal")
}
