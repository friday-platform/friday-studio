package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/apps/gateway/repo"
)

// withUserContext executes a function within a transaction with the request.user_id
// session variable set for RLS policy enforcement.
//
// The session variable is set with LOCAL scope (transaction-only) to ensure
// it doesn't leak to other queries using the same connection from the pool.
func withUserContext(
	ctx context.Context,
	pool *pgxpool.Pool,
	userID string,
	fn func(queries *repo.Queries) error,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	defer func() {
		if tx != nil {
			_ = tx.Rollback(ctx)
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

	queries := repo.New(tx)

	if err := fn(queries); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	tx = nil

	return nil
}
