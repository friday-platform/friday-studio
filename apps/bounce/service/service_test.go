package service

import (
	"net/http"
	"net/http/httptest"
)

func executeRequest(req *http.Request, r http.Handler) *http.Response {
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	return rr.Result()
}

func cfg() Config {
	return Config{
		JWTPrivateKey:             "test",
		JWTPublicKey:              "test",
		LogLevel:                  "debug",
		PostgresConnection:        "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable",
		OAuthGoogleCredentialJSON: `{"web":{"client_id":"test","redirect_uris":["http://acme.com"]}}`,
	}
}
