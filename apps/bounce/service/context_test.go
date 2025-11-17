package service

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
)

func TestConfigFromContext(t *testing.T) {
	t.Parallel()
	c := cfg()
	s := New(c)

	s.mux.Use(ConfigCtxMiddleware(c))
	s.mux.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		ctx, err := ConfigFromContext(r.Context())
		assert.Nil(t, err)
		assert.Equal(t, c, ctx)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	res := executeRequest(req, s.mux)
	assert.Equal(t, 200, res.StatusCode)
}

func TestConfigMissingFromContext(t *testing.T) {
	t.Parallel()
	c := Config{}
	s := chi.NewRouter()

	s.Get("/test", func(w http.ResponseWriter, r *http.Request) {
		config, err := ConfigFromContext(r.Context())
		assert.Error(t, err, "if context middleware was never configured, we should get an error")
		assert.Equal(t, c, config, "if context middleware was never configured, we should get an empty config")
	})

	req := httptest.NewRequest("GET", "/test", nil)
	executeRequest(req, s)
}
