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

// testPostgresURL is a fake connection string for testing (not real credentials).
const testPostgresURL = "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable" //nolint:gosec // G101: test fixture

func cfg() Config {
	return Config{ //nolint:gosec // G101: test fixture with fake credentials
		JWTPrivateKey:             "test",
		JWTPublicKey:              "test",
		LogLevel:                  "debug",
		PostgresConnection:        testPostgresURL,
		OAuthGoogleCredentialJSON: `{"web":{"client_id":"test","redirect_uris":["http://acme.com"]}}`,
	}
}
