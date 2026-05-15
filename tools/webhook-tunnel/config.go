package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/passphrase"
)

// Config is env-derived runtime configuration.
//
// Fields and env vars match the TS implementation (apps/webhook-tunnel/
// src/config.ts) so existing deployments need no env changes.
type Config struct {
	AtlasdURL     string
	WebhookSecret string
	Port          int
	TunnelToken   string
	NoTunnel      bool
	// TLS cert/key paths (FRIDAY_TLS_CERT / FRIDAY_TLS_KEY) for our own
	// listener. When both are set the server speaks HTTPS; cloudflared's
	// local origin URL follows the same scheme. Empty in plain-HTTP mode.
	TLSCert string
	TLSKey  string
	// FRIDAY_TLS_CA — path to the private s2s CA bundle. Used in two
	// places: (1) the forwarder loads it to verify atlasd's s2s leaf on
	// outbound POSTs, and (2) cloudflared receives it via
	// --origin-ca-pool to verify the webhook-tunnel listener's own leaf
	// on the loopback hop. Both leaves chain to the same CA — the system
	// trust store has no entry for it, so without this both paths
	// x509-error. Empty when the mesh is on plain HTTP.
	FridayCA string
}

func loadConfig() (*Config, error) {
	port := 9090
	if v := os.Getenv("TUNNEL_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("TUNNEL_PORT=%q: %w", v, err)
		}
		port = n
	}
	atlasdURL := os.Getenv("FRIDAYD_URL")
	if atlasdURL == "" {
		atlasdURL = "http://localhost:8080"
	}
	fridayCA := os.Getenv("FRIDAY_TLS_CA")
	// Auto-upgrade scheme when the local s2s CA is configured: atlasd
	// will be on HTTPS and a stale http:// FRIDAYD_URL (e.g. left over
	// from a prior non-TLS run) would otherwise hit a TLS listener
	// with cleartext bytes and fail. Mirrors getAtlasDaemonUrl()'s
	// upgrade in packages/openapi-client/src/utils.ts. We don't
	// downgrade https→http for the same reason as the TS path.
	if fridayCA != "" && strings.HasPrefix(atlasdURL, "http://") {
		atlasdURL = "https://" + strings.TrimPrefix(atlasdURL, "http://")
	}
	secret := os.Getenv("WEBHOOK_SECRET")
	if secret == "" {
		secret = passphrase.Generate()
	}
	return &Config{
		AtlasdURL:     atlasdURL,
		WebhookSecret: secret,
		Port:          port,
		TunnelToken:   os.Getenv("TUNNEL_TOKEN"),
		NoTunnel:      os.Getenv("NO_TUNNEL") == "true",
		TLSCert:       os.Getenv("FRIDAY_TLS_CERT"),
		TLSKey:        os.Getenv("FRIDAY_TLS_KEY"),
		FridayCA:      fridayCA,
	}, nil
}
