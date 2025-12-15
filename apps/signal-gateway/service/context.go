package service

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

type contextKey struct {
	name string
}

var dbContextKey = &contextKey{"db"}

// DBCtxMiddleware injects database pool into request context.
func DBCtxMiddleware(db *pgxpool.Pool) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), dbContextKey, db)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// DBFromContext retrieves database pool from the context.
func DBFromContext(ctx context.Context) (*pgxpool.Pool, error) {
	v := ctx.Value(dbContextKey)
	db, ok := v.(*pgxpool.Pool)
	if !ok {
		return nil, errors.New("could not get db from context")
	}
	return db, nil
}
