// Package metrics provides a shared Prometheus metrics server for Go services.
package metrics

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tempestteam/atlas/pkg/server"
)

// StartServer starts an HTTP server that exposes Prometheus metrics on /metrics.
// If tlsConfig is provided and configured, the server will use TLS.
// Returns the server so it can be shutdown gracefully.
func StartServer(port string, tlsConfig *server.TLSConfig) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	if tlsConfig != nil && tlsConfig.GetTLSConfig() != nil {
		srv.TLSConfig = tlsConfig.GetTLSConfig()
		go func() {
			if err := srv.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("metrics server failed", "error", err)
				os.Exit(1)
			}
		}()
	} else {
		go func() {
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("metrics server failed", "error", err)
				os.Exit(1)
			}
		}()
	}

	return srv
}

// Shutdown gracefully shuts down the metrics server.
func Shutdown(ctx context.Context, srv *http.Server) error {
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}
