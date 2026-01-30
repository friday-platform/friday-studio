package service

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type contextKey struct {
	name string
}

var (
	dbContextKey      = &contextKey{"db"}
	storageContextKey = &contextKey{"storage"}
)

// Storage defines the interface for blob storage operations.
type Storage interface {
	Upload(ctx context.Context, id uuid.UUID, data io.Reader) (int64, error)
	Download(ctx context.Context, id uuid.UUID) (io.ReadCloser, error)
}

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

// StorageCtxMiddleware injects storage client into request context.
func StorageCtxMiddleware(storage Storage) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), storageContextKey, storage)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// StorageFromContext retrieves storage client from the context.
func StorageFromContext(ctx context.Context) (Storage, error) {
	v := ctx.Value(storageContextKey)
	storage, ok := v.(Storage)
	if !ok {
		return nil, errors.New("could not get storage from context")
	}
	return storage, nil
}
