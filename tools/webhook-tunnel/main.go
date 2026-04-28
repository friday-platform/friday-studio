// webhook-tunnel — receives external webhooks via a Cloudflare tunnel
// and forwards them to atlasd as workspace signal triggers.
//
// URL pattern: /hook/{provider}/{workspaceId}/{signalId}
//
// Environment:
//
//	ATLASD_URL      — Daemon API URL (default http://localhost:8080)
//	WEBHOOK_SECRET  — Shared secret for HMAC verification
//	                  (auto-generated diceware passphrase if unset)
//	TUNNEL_PORT     — Local listener port (default 9090)
//	TUNNEL_TOKEN    — Cloudflare tunnel token for stable URLs (optional)
//	NO_TUNNEL       — "true" to skip cloudflared (HTTP server only)
//	WEBHOOK_MAPPINGS_PATH — Override the embedded webhook-mappings.yml
//	ATLAS_LOG_LEVEL — trace|debug|info|warn|error|fatal
//
// Faithful Go port of apps/webhook-tunnel (TS / Hono / Deno).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/friday-platform/friday-studio/pkg/logger"
	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/cloudflared"
	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/forwarder"
	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/provider"
	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/tunnel"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
)

// maxBodySize caps request bodies for /hook and /platform routes.
// 25 MB matches GitHub's documented webhook payload max — the most
// generous of the common providers. Oversized bodies get 413 before
// any handler reads them so a hostile caller can't OOM the process.
const maxBodySize = 25 * 1024 * 1024

// shutdownTimeout matches the TS implementation's 25-second drain.
const shutdownTimeout = 25 * time.Second

var (
	log    = logger.New("webhook-tunnel")
	tunMgr *tunnel.Manager
	fwd    *forwarder.Forwarder
	cfg    *Config
)

func main() {
	conf, err := loadConfig()
	if err != nil {
		log.Fatal("config error", "error", err)
	}
	cfg = conf
	if err := provider.Init(); err != nil {
		log.Fatal("provider init", "error", err)
	}
	fwd = forwarder.New(cfg.AtlasdURL)

	r := newRouter()

	srv := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Info("webhook listener starting",
		"port", cfg.Port,
		"atlasd_url", cfg.AtlasdURL,
		"secret_configured", cfg.WebhookSecret != "")

	serverErr := make(chan error, 1)
	go func() {
		err := srv.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	if !cfg.NoTunnel {
		startTunnel()
	} else {
		log.Info("tunnel disabled",
			"local_url", fmt.Sprintf("http://localhost:%d/hook/{provider}/{workspaceId}/{signalId}", cfg.Port))
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-serverErr:
		log.Error("HTTP server failed", "error", err)
		performShutdown(srv)
		os.Exit(1)
	case sig := <-stop:
		log.Info("shutdown signal received", "signal", sig.String())
		performShutdown(srv)
	}
}

func startTunnel() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	bin, err := cloudflared.Resolve(ctx)
	if err != nil {
		log.Error("cloudflared resolve failed; tunnel disabled", "error", err)
		return
	}
	log.Info("cloudflared resolved", "path", bin)
	tunMgr = tunnel.New(tunnel.Options{
		Port:           cfg.Port,
		TunnelToken:    cfg.TunnelToken,
		CloudflaredBin: bin,
		Logger:         log.Child("subcomponent", "tunnel"),
	})
	if err := tunMgr.Start(ctx); err != nil {
		log.Error("tunnel startup failed", "error", err)
		return
	}
	url := tunMgr.URL()
	log.Info("webhook tunnel ready", "public_url", url)
	if url != "" {
		printTunnelBanner(url)
	}
}

// printTunnelBanner mirrors the TS console.log block so existing
// dev/setup docs keep showing the same UX.
func printTunnelBanner(tunnelURL string) {
	fmt.Println()
	fmt.Println("================================================================")
	fmt.Println("  Webhook Tunnel ready!")
	fmt.Println()
	fmt.Printf("  Public URL:  %s\n", tunnelURL)
	fmt.Println()
	fmt.Println("  Register webhooks using:")
	fmt.Printf("    %s/hook/{provider}/{workspaceId}/{signalId}\n", tunnelURL)
	fmt.Println()
	fmt.Println("  Examples:")
	fmt.Printf("    GitHub:     %s/hook/github/{workspaceId}/review-pr\n", tunnelURL)
	fmt.Printf("    Bitbucket:  %s/hook/bitbucket/{workspaceId}/review-pr\n", tunnelURL)
	fmt.Printf("    Raw:        %s/hook/raw/{workspaceId}/{signalId}\n", tunnelURL)
	fmt.Println()
	fmt.Println("  Auto-reconnect: enabled (process monitor + health probe)")
	fmt.Println("================================================================")
	fmt.Println()
}

func performShutdown(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if tunMgr != nil {
		tunMgr.Stop()
		log.Info("tunnel manager stopped")
	}
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("HTTP shutdown error", "error", err)
	} else {
		log.Info("HTTP server stopped")
	}
	log.Info("shutdown complete")
}

// newRouter wires up the chi router with all webhook-tunnel routes.
// Extracted so tests reuse the exact same routing as production.
func newRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/health", handleHealth)
	// /status: GET returns JSON. CORS allows cross-origin from the
	// playground (localhost:5200 → :9090). The cors handler on the
	// route registers an OPTIONS preflight responder automatically.
	r.With(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
		MaxAge:           300,
	})).Get("/status", handleStatus)
	r.Options("/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Max-Age", "300")
		w.WriteHeader(http.StatusNoContent)
	})
	r.Get("/", handleRoot)
	r.Post("/hook/{provider}/{workspaceId}/{signalId}", handleHook)
	// /platform/{provider}[/{suffix...}] reverse-proxies to atlasd.
	// httputil.ReverseProxy automatically strips RFC 7230 hop-by-hop
	// headers — we don't need to do that ourselves.
	platformHandler := wrapMaxBytes(fwd.ProxyHandler())
	r.Handle("/platform/{provider}", platformHandler)
	r.Handle("/platform/{provider}/*", platformHandler)
	return r
}

// ---------- handlers ----------

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	tunnelAlive := cfg.NoTunnel
	if tunMgr != nil {
		tunnelAlive = tunMgr.Status().Alive
	}
	status := "ok"
	if !tunnelAlive {
		status = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      status,
		"service":     "webhook-tunnel",
		"tunnelAlive": tunnelAlive,
	})
}

func handleStatus(w http.ResponseWriter, _ *http.Request) {
	var url *string
	var alive, tunnelAlive bool
	var restartCount int
	var lastProbeAt *string
	if tunMgr != nil {
		st := tunMgr.Status()
		if st.URL != "" {
			s := st.URL
			url = &s
		}
		alive = st.Alive
		tunnelAlive = st.Alive
		restartCount = st.RestartCount
		if !st.LastProbeAt.IsZero() {
			s := st.LastProbeAt.UTC().Format(time.RFC3339Nano)
			lastProbeAt = &s
		}
	}
	var secret *string
	if cfg.WebhookSecret != "" {
		s := cfg.WebhookSecret
		secret = &s
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"url":          url,
		"secret":       secret,
		"providers":    provider.List(),
		"pattern":      "/hook/{provider}/{workspaceId}/{signalId}",
		"active":       alive,
		"tunnelAlive":  tunnelAlive,
		"restartCount": restartCount,
		"lastProbeAt":  lastProbeAt,
	})
}

func handleRoot(w http.ResponseWriter, _ *http.Request) {
	var url *string
	if tunMgr != nil {
		if u := tunMgr.URL(); u != "" {
			url = &u
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service":   "webhook-tunnel",
		"providers": provider.List(),
		"pattern":   "/hook/{provider}/{workspaceId}/{signalId}",
		"url":       url,
	})
}

func handleHook(w http.ResponseWriter, r *http.Request) {
	providerName := chi.URLParam(r, "provider")
	workspaceID := chi.URLParam(r, "workspaceId")
	signalID := chi.URLParam(r, "signalId")

	h := provider.Get(providerName)
	if h == nil {
		writeJSONError(w, http.StatusBadRequest,
			fmt.Sprintf("Unknown provider: %s. Available: %s",
				providerName, strings.Join(provider.List(), ", ")))
		return
	}

	// Read body once into bytes — verify + transform both consume from
	// the same []byte. (Go net/http does NOT buffer req.Body, unlike
	// Hono.) MaxBytesReader returns 413 on overflow before we read.
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mre *http.MaxBytesError
		if errors.As(err, &mre) {
			writeJSONError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("body exceeds %d bytes", maxBodySize))
			return
		}
		writeJSONError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}

	if vErr := h.Verify(r.Header, body, []byte(cfg.WebhookSecret)); vErr != nil {
		log.Error("signature verification failed",
			"provider", providerName, "error", vErr)
		writeJSONError(w, http.StatusUnauthorized, vErr.Error())
		return
	}

	payload, desc, tErr := h.Transform(r.Header, body)
	if tErr != nil {
		writeJSONError(w, http.StatusBadRequest, tErr.Error())
		return
	}
	if payload == nil {
		log.Debug("event skipped",
			"provider", providerName, "reason", "irrelevant event")
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "skipped", "reason": "irrelevant event",
		})
		return
	}

	log.Info("webhook received",
		"provider", providerName,
		"description", desc,
		"workspace_id", workspaceID,
		"signal_id", signalID)

	sessionID, fErr := fwd.Forward(workspaceID, signalID, payload)
	if fErr != nil {
		log.Error("forward to atlasd failed",
			"provider", providerName,
			"workspace_id", workspaceID,
			"signal_id", signalID,
			"error", fErr)
		writeJSONError(w, http.StatusBadGateway,
			fmt.Sprintf("Cannot reach atlasd: %v", fErr))
		return
	}
	log.Info("signal triggered",
		"provider", providerName,
		"workspace_id", workspaceID,
		"signal_id", signalID,
		"session_id", sessionID)
	resp := map[string]any{"status": "forwarded"}
	if sessionID != "" {
		resp["sessionId"] = sessionID
	}
	writeJSON(w, http.StatusOK, resp)
}

// wrapMaxBytes applies the body-size cap to the platform proxy so a
// pathologically large pass-through request can't OOM the process.
func wrapMaxBytes(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
		h.ServeHTTP(w, r)
	})
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
