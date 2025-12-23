package service

import (
	"context"
	"fmt"

	"github.com/tempestteam/atlas/apps/cortex/repo"
)

// withUserContext executes a function within a transaction with the request.user_id
// session variable set for RLS policy enforcement. For read operations that return
// a value, use withUserContextRead instead.
//
// The session variable is set with LOCAL scope (transaction-only) to ensure
// it doesn't leak to other queries using the same connection from the pool.
func withUserContext(
	ctx context.Context,
	userID string,
	fn func(queries *repo.Queries) error,
) error {
	pool, err := DBFromContext(ctx)
	if err != nil {
		return fmt.Errorf("failed to get db from context: %w", err)
	}

	// Begin transaction (acquires connection from pool automatically)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	// Ensure transaction is rolled back on error
	defer func() {
		if tx != nil {
			_ = tx.Rollback(ctx) // Ignore error if already committed
		}
	}()

	// Set role to authenticated for RLS policy enforcement
	// Using LOCAL scope ensures it only applies to this transaction
	_, err = tx.Exec(ctx, "SET LOCAL ROLE authenticated")
	if err != nil {
		return fmt.Errorf("failed to set role: %w", err)
	}

	// Set session variable for RLS policy
	// Must come AFTER SET LOCAL ROLE
	_, err = tx.Exec(ctx, "SELECT set_config('request.user_id', $1, true)", userID)
	if err != nil {
		return fmt.Errorf("failed to set request.user_id: %w", err)
	}

	// Create queries interface backed by transaction
	queries := repo.New(tx)

	// Execute user function
	if err := fn(queries); err != nil {
		return err
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	// Mark transaction as committed so defer doesn't try to rollback
	tx = nil

	return nil
}

// withUserContextRead is like withUserContext but returns a value from the query.
func withUserContextRead[T any](
	ctx context.Context,
	userID string,
	fn func(queries *repo.Queries) (T, error),
) (T, error) {
	var result T
	err := withUserContext(ctx, userID, func(queries *repo.Queries) error {
		var err error
		result, err = fn(queries)
		return err
	})
	return result, err
}
