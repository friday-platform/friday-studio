package pgxdb

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/pkg/x/middleware"
)

var ErrNotFound = errors.New("pgxdb: nil value in context")

type ErrKeyNotFound struct {
	Key string
}

func (e *ErrKeyNotFound) Error() string {
	return "pgxdb: key not found: " + e.Key
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
	if name == "" {
		panic(panicMsg)
	}

	if db == nil {
		panic(panicMsg)
	}

	ctxKey := middleware.AddContextKey(name)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), ctxKey, db)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func dbFromContext[T dbType](ctx context.Context, name string) (T, error) {
	key := middleware.GetContextKey(name)
	if key == nil {
		return nil, &ErrKeyNotFound{name}
	}

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
