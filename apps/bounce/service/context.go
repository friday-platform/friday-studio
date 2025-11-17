package service

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-playground/validator/v10"
)

type contextKey string

const configContextKey contextKey = "config"

func ConfigCtxMiddleware(cfg Config) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), configContextKey, cfg)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func ConfigFromContext(ctx context.Context) (Config, error) {
	v := ctx.Value(configContextKey)
	config, ok := v.(Config)
	if !ok {
		return Config{}, errors.New("could not get config from context")
	}

	return config, nil
}

var validate = validator.New(validator.WithRequiredStructEnabled())
