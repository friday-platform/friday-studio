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
	userIDContextKey    = &contextKey{"userID"}
	keyCacheContextKey  = &contextKey{"keyCache"}
	tokenDepsContextKey = &contextKey{"tokenDeps"}
)

// UserIDFromContext retrieves the user ID from the context.
func UserIDFromContext(ctx context.Context) (string, error) {
	v := ctx.Value(userIDContextKey)
	userID, ok := v.(string)
	if !ok || userID == "" {
		return "", errors.New("could not get user ID from context")
	}
	return userID, nil
}

// WithUserID adds a user ID to the context.
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDContextKey, userID)
}

// KeyCacheCtxMiddleware injects the key cache into the request context.
func KeyCacheCtxMiddleware(cache *KeyCache) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), keyCacheContextKey, cache)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// KeyCacheFromContext retrieves the key cache from the context.
func KeyCacheFromContext(ctx context.Context) (*KeyCache, error) {
	v := ctx.Value(keyCacheContextKey)
	cache, ok := v.(*KeyCache)
	if !ok {
		return nil, errors.New("could not get key cache from context")
	}
	return cache, nil
}

// TokenDepsCtxMiddleware injects TokenDeps into request context.
func TokenDepsCtxMiddleware(deps *TokenDeps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), tokenDepsContextKey, deps)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// TokenDepsFromContext retrieves TokenDeps from the context.
func TokenDepsFromContext(ctx context.Context) (*TokenDeps, error) {
	deps, ok := ctx.Value(tokenDepsContextKey).(*TokenDeps)
	if !ok || deps == nil {
		return nil, errors.New("could not get token deps from context")
	}
	return deps, nil
}
