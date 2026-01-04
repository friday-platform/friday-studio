package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/phuslu/lru"
	"github.com/tink-crypto/tink-go/v2/aead"
	"github.com/tink-crypto/tink-go/v2/keyset"
	"github.com/tink-crypto/tink-go/v2/tink"

	cypherKms "github.com/tempestteam/atlas/apps/cypher/kms"
	"github.com/tempestteam/atlas/apps/cypher/repo"
)

// KeyCache provides thread-safe access to user AEAD primitives with LRU caching.
// Cache misses load from the database; if no key exists, a new one is created.
type KeyCache struct {
	pool  *pgxpool.Pool
	kms   cypherKms.KeyEncryptionService
	cache *lru.TTLCache[string, tink.AEAD]
}

// NewKeyCache creates a new KeyCache with the given pool, KMS, and cache size.
// The pool is used for RLS-scoped transactions with user context.
func NewKeyCache(pool *pgxpool.Pool, kms cypherKms.KeyEncryptionService, cacheSize int) *KeyCache {
	return &KeyCache{
		pool:  pool,
		kms:   kms,
		cache: lru.NewTTLCache[string, tink.AEAD](cacheSize),
	}
}

// Pool returns the database connection pool.
func (c *KeyCache) Pool() *pgxpool.Pool { return c.pool }

// GetAEAD returns the AEAD primitive for a user, loading from DB or creating if needed.
func (c *KeyCache) GetAEAD(ctx context.Context, userID string) (tink.AEAD, error) {
	// Check cache first
	if cachedAEAD, ok := c.cache.Get(userID); ok {
		RecordCacheHit()
		return cachedAEAD, nil
	}

	RecordCacheMiss()

	// Try to load from database
	aeadPrimitive, err := c.loadFromDB(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load keyset from database: %w", err)
	}

	if aeadPrimitive != nil {
		c.cache.Set(userID, aeadPrimitive, 0)
		return aeadPrimitive, nil
	}

	// No keyset exists, create a new one
	aeadPrimitive, err = c.createAndStore(ctx, userID)
	if err != nil {
		// Handle race: another request created the key concurrently
		if isUniqueViolation(err) {
			aeadPrimitive, loadErr := c.loadFromDB(ctx, userID)
			if loadErr != nil {
				return nil, fmt.Errorf("failed to load keyset after race: %w", loadErr)
			}
			if aeadPrimitive != nil {
				c.cache.Set(userID, aeadPrimitive, 0)
				return aeadPrimitive, nil
			}
			// Keyset disappeared between INSERT and SELECT - shouldn't happen
		}
		return nil, fmt.Errorf("failed to create new keyset: %w", err)
	}

	c.cache.Set(userID, aeadPrimitive, 0)
	RecordKeyCreated()
	return aeadPrimitive, nil
}

// isUniqueViolation checks if the error is a PostgreSQL unique constraint violation.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// loadFromDB loads an encrypted keyset from the database and returns the AEAD primitive.
// Returns nil, nil if no keyset exists for the user.
// Uses RLS-scoped transaction with request.user_id session variable.
func (c *KeyCache) loadFromDB(ctx context.Context, userID string) (tink.AEAD, error) {
	// Execute query within RLS-scoped transaction
	row, err := withUserContextRead(ctx, c.pool, userID, func(queries *repo.Queries) (*repo.CypherKeyset, error) {
		return queries.GetKeysetByUserID(ctx, userID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("database query failed: %w", err)
	}

	// Get key encryption AEAD from KMS
	keyEncryptionAEAD, err := c.kms.GetAEADBackend()
	if err != nil {
		return nil, fmt.Errorf("failed to get key encryption AEAD: %w", err)
	}

	// Decrypt the keyset
	reader := keyset.NewBinaryReader(bytes.NewReader(row.KeySet))
	handle, err := keyset.Read(reader, keyEncryptionAEAD)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt keyset: %w", err)
	}

	// Get AEAD primitive from handle
	aeadPrimitive, err := aead.New(handle)
	if err != nil {
		return nil, fmt.Errorf("failed to create AEAD from handle: %w", err)
	}

	return aeadPrimitive, nil
}

// createAndStore creates a new AES-256-GCM keyset, encrypts it with KMS, and stores it.
// Uses RLS-scoped transaction with request.user_id session variable.
func (c *KeyCache) createAndStore(ctx context.Context, userID string) (tink.AEAD, error) {
	// Generate new AES-256-GCM keyset
	handle, err := keyset.NewHandle(aead.AES256GCMKeyTemplate())
	if err != nil {
		return nil, fmt.Errorf("failed to generate keyset: %w", err)
	}

	// Get key encryption AEAD from KMS
	keyEncryptionAEAD, err := c.kms.GetAEADBackend()
	if err != nil {
		return nil, fmt.Errorf("failed to get key encryption AEAD: %w", err)
	}

	// Encrypt keyset
	buf := new(bytes.Buffer)
	writer := keyset.NewBinaryWriter(buf)
	if err := handle.Write(writer, keyEncryptionAEAD); err != nil {
		return nil, fmt.Errorf("failed to encrypt keyset: %w", err)
	}

	// Store in database within RLS-scoped transaction
	err = withUserContext(ctx, c.pool, userID, func(queries *repo.Queries) error {
		_, err := queries.CreateKeyset(ctx, &repo.CreateKeysetParams{
			UserID: userID,
			KeySet: buf.Bytes(),
		})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("failed to store keyset: %w", err)
	}

	// Get AEAD primitive from handle
	aeadPrimitive, err := aead.New(handle)
	if err != nil {
		return nil, fmt.Errorf("failed to create AEAD from handle: %w", err)
	}

	return aeadPrimitive, nil
}
