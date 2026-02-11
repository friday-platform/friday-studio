package repo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a new connection pool with standard configuration.
func NewPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}

	config.MinConns = 5
	config.MaxConns = 10
	config.MaxConnLifetime = 15 * time.Minute
	config.MaxConnIdleTime = 5 * time.Minute

	return pgxpool.NewWithConfig(ctx, config)
}
