// webhook-tunnel — receives external webhooks via a Cloudflare tunnel
// and forwards them to atlasd as workspace signal triggers.
//
// URL pattern: /hook/raw/{workspaceId}/{signalId}
//
// The body of the POST becomes the signal payload as-is. No HMAC
// verification, no event filtering, no field extraction — workspace
// agents own all of that. There is one provider (`raw`); the URL
// segment is retained as a stable path prefix so any future provider
// can be added without breaking existing webhook configurations.
//
// Environment:
//
//	FRIDAYD_URL      — Daemon API URL (default http://localhost:8080)
//	TUNNEL_PORT     — Local listener port (default 9090)
//	TUNNEL_TOKEN    — Cloudflare tunnel token for stable URLs (optional)
//	NO_TUNNEL       — "true" to skip cloudflared (HTTP server only)
//	FRIDAY_LOG_LEVEL — trace|debug|info|warn|error|fatal
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
	"path/filepath"
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
	"github.com/joho/godotenv"
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
	// Load FRIDAY_HOME/.env so FRIDAY_TLS_CERT/_KEY (and any other
	// caller-supplied env) land before loadConfig() reads them. Mirrors
	// atlas-cli daemon-start; existing process env wins (Load doesn't
	// overwrite). Tolerant — missing .env is fine on a fresh install.
	envPath := filepath.Join(fridayHome(), ".env")
	if _, err := os.Stat(envPath); err == nil {
		if err := godotenv.Load(envPath); err != nil {
			log.Warn(".env load failed; continuing with shell env", "path", envPath, "error", err)
		}
	}

	conf, err := loadConfig()
	if err != nil {
		log.Fatal("config error", "error", err)
	}
	cfg = conf
	if err := provider.Init(); err != nil {
		log.Fatal("provider init", "error", err)
	}
	f, err := forwarder.New(cfg.AtlasdURL, cfg.FridayCA)
	if err != nil {
		log.Fatal("forwarder init", "error", err)
	}
	fwd = f

	r := newRouter()

	// Bind loopback-only by default — webhook-tunnel exposes the local
	// receiver that cloudflared bridges public traffic into. Direct LAN
	// access bypasses the cloudflared-side authentication / signing the
	// receiver assumes is on the public path. TUNNEL_BIND_HOST escape
	// hatch for containers / production where 0.0.0.0 is needed.
	bindHost := os.Getenv("TUNNEL_BIND_HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", bindHost, cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	tlsOn := cfg.TLSCert != "" && cfg.TLSKey != ""
	scheme := "http"
	if tlsOn {
		scheme = "https"
	}
	log.Info("webhook listener starting",
		"port", cfg.Port,
		"scheme", scheme,
		"atlasd_url", cfg.AtlasdURL)

	serverErr := make(chan error, 1)
	go func() {
		var err error
		if tlsOn {
			// Both files supplied — speak HTTPS. cloudflared's local
			// origin URL (tunnel/manager.go) follows the same scheme so
			// the public path stays end-to-end TLS.
			err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	if !cfg.NoTunnel {
		startTunnel(tlsOn)
	} else {
		log.Info("tunnel disabled",
			"local_url", fmt.Sprintf("%s://localhost:%d/hook/{provider}/{workspaceId}/{signalId}", scheme, cfg.Port))
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

func startTunnel(tlsOn bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Surface the misconfig that would otherwise look like a 502 from
	// Cloudflare's edge: HTTPS origin without a CA bundle means
	// cloudflared falls back to its system trust store, which has no
	// entry for our private s2s CA, so every webhook x509-errors on the
	// loopback hop. Logging here saves the next debugger from chasing
	// the 502 back through cloudflared and the public edge.
	if tlsOn && cfg.FridayCA == "" {
		log.Warn("TLS origin without FRIDAY_TLS_CA — cloudflared will likely 502 on inbound webhooks (no --origin-ca-pool)")
	}
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
		TLS:            tlsOn,
		OriginCA:       cfg.FridayCA,
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
	fmt.Println("  Register webhooks at:")
	fmt.Printf("    %s/hook/raw/{workspaceId}/{signalId}\n", tunnelURL)
	fmt.Println()
	fmt.Println("  The body of the POST becomes the signal payload as-is.")
	fmt.Println("  The workspace agent owns parsing and any HMAC verification.")
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
	writeJSON(w, http.StatusOK, map[string]any{
		"url":          url,
		"providers":    provider.List(),
		"pattern":      "/hook/raw/{workspaceId}/{signalId}",
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
		"pattern":   "/hook/raw/{workspaceId}/{signalId}",
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

// fridayHome resolves the per-user data dir, mirroring atlasd's
// getFridayHome() resolution order: $FRIDAY_HOME wins, otherwise
// ~/.atlas (legacy / dev) if it exists, falling back to
// ~/.friday/local (new desktop / installer default).
func fridayHome() string {
	if v := os.Getenv("FRIDAY_HOME"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	atlas := filepath.Join(home, ".atlas")
	if st, err := os.Stat(atlas); err == nil && st.IsDir() {
		return atlas
	}
	return filepath.Join(home, ".friday", "local")
}
