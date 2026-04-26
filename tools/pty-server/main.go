// pty-server is a small WebSocket bridge that spawns a shell PTY per
// connection and forwards bytes both ways. It replaces the TS server
// at tools/pty-server/server.ts; the wire protocol is byte-identical so
// the only consumer (cheatsheet.svelte) keeps working unchanged.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/caarlos0/env/v11"
)

// GitCommit is injected at build time via -ldflags
// "-X main.GitCommit=$GITHUB_SHA". Used by --version.
var GitCommit = "unknown"

// Config holds env-derived runtime configuration. PTY_PORT="0" picks an
// ephemeral kernel-assigned port (used by integration tests).
type Config struct {
	Port     string `env:"PTY_PORT" envDefault:"7681"`
	Shell    string `env:"PTY_SHELL"`
	Cwd      string `env:"PTY_CWD"`
	LogLevel string `env:"PTY_LOG_LEVEL" envDefault:"info"`
}

// printVersion writes the version line to w. Extracted so tests can
// exercise it without re-invoking `go build`.
func printVersion(w io.Writer) {
	_, _ = fmt.Fprintf(w, "pty-server %s\n", GitCommit)
}

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *versionFlag {
		printVersion(os.Stdout)
		return
	}

	var cfg Config
	if err := env.Parse(&cfg); err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(1)
	}

	setupLogger(cfg.LogLevel)

	if err := run(cfg); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func setupLogger(level string) {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: lvl,
	})))
}

func run(cfg Config) error {
	mux := http.NewServeMux()

	// /health — kept as /health (NOT /healthz) to match the cheatsheet
	// client at tools/agent-playground/.../cheatsheet.svelte:44.
	// Other Go services in this repo use /healthz; do not "harmonize"
	// this path without updating the client.
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/pty", handlePty(cfg))

	// gosec G114: ReadHeaderTimeout is mandatory.
	// WriteTimeout/IdleTimeout are explicit zeros because this is a
	// long-lived WS server; keepalive pings handle liveness.
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Listen first so PTY_PORT=0 (ephemeral) is observable in logs.
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	resolvedAddr := ln.Addr().String()

	slog.Info("pty-server listening",
		"commit", GitCommit,
		"addr", resolvedAddr,
		"pid", os.Getpid(),
	)

	serverErr := make(chan error, 1)
	go func() {
		err := srv.Serve(ln)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErr:
		return fmt.Errorf("serve: %w", err)
	case sig := <-stop:
		slog.Info("shutting down",
			"signal", sig.String(),
			"active_conns", activeConns.Load(),
		)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func setCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
}
