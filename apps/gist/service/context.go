package service

import (
	"context"
	"errors"
	"net/http"
)

type contextKey struct {
	name string
}

var (
	storageContextKey      = &contextKey{"storage"}
	shareBaseURLContextKey = &contextKey{"shareBaseURL"}
)

func StorageClientCtxMiddleware(client *StorageClient) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), storageContextKey, client)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func StorageClientFromContext(ctx context.Context) (*StorageClient, error) {
	v := ctx.Value(storageContextKey)
	client, ok := v.(*StorageClient)
	if !ok {
		return nil, errors.New("could not get storage client from context")
	}
	return client, nil
}

func ShareBaseURLCtxMiddleware(baseURL string) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), shareBaseURLContextKey, baseURL)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func ShareBaseURLFromContext(ctx context.Context) (string, error) {
	v := ctx.Value(shareBaseURLContextKey)
	baseURL, ok := v.(string)
	if !ok {
		return "", errors.New("could not get share base URL from context")
	}
	return baseURL, nil
}
