package pgxdb

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("pgxdb: nil value in context")

type contextKey struct {
	name string
}

type dbType interface {
	*pgxpool.Pool | *pgx.Conn
}

func WithPool(db *pgxpool.Pool, name string) func(http.Handler) http.Handler {
	return withDB[*pgxpool.Pool](db, name, "pgxdb.WithPool: db and name cannot be nil")
}

func WithConn(db *pgx.Conn, name string) func(http.Handler) http.Handler {
	return withDB[*pgx.Conn](db, name, "pgxdb.WithConn: db and name cannot be nil")
}

func PoolFromContext(ctx context.Context, name string) (*pgxpool.Pool, error) {
	return dbFromContext[*pgxpool.Pool](ctx, name)
}

func ConnFromContext(ctx context.Context, name string) (*pgx.Conn, error) {
	return dbFromContext[*pgx.Conn](ctx, name)
}

func withDB[T dbType](db T, name, panicMsg string) func(http.Handler) http.Handler {
	if name == "" || db == nil {
		panic(panicMsg)
	}

	ctxKey := &contextKey{name}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), ctxKey, db)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func dbFromContext[T dbType](ctx context.Context, name string) (T, error) {
	key := &contextKey{name}
	v := ctx.Value(key)
	if v == nil {
		return nil, ErrNotFound
	}

	db, ok := v.(T)
	if !ok {
		return nil, ErrNotFound
	}
	return db, nil
}
