package main

import (
	"fmt"
	"os"
	"strconv"

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
	}, nil
}
