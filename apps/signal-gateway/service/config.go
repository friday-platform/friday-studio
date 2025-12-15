package service

import (
	"fmt"

	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

// Config holds all configuration for the Signal Gateway service.
type Config struct {
	// Service configuration.
	ServiceName string `env:"SERVICE_NAME" envDefault:"signal-gateway"`
	Port        string `env:"PORT" envDefault:"8080"`
	MetricsPort string `env:"METRICS_PORT" envDefault:"9090"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"info"`

	// Database configuration.
	PostgresConnection string `env:"POSTGRES_CONNECTION" envDefault:"postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable"`

	// Slack configuration (required).
	SlackBotToken      string `env:"SLACK_BOT_TOKEN"`
	SlackSigningSecret string `env:"SLACK_SIGNING_SECRET"`

	// Atlas instance configuration.
	AtlasURLTemplate  string `env:"ATLAS_URL_TEMPLATE" envDefault:"https://atlas-%s.atlas.svc.cluster.local"`
	CallbackURLPrefix string `env:"CALLBACK_URL_PREFIX" envDefault:"https://signal-gateway.atlas-operator.svc.cluster.local/callback"`

	// HTTP client configuration.
	AtlasTimeoutSeconds int `env:"ATLAS_TIMEOUT_SECONDS" envDefault:"10"`

	// Cache configuration.
	RouteCacheTTLMinutes int `env:"ROUTE_CACHE_TTL_MINUTES" envDefault:"5"`

	// TLS configuration.
	TLSConfig *server.TLSConfig

	// Profiler configuration.
	Profiler profiler.Config
}

// Validate checks configuration validity.
// Service requires complete Slack configuration.
func (c Config) Validate() error {
	// Validate Slack configuration completeness (both required).
	if c.SlackBotToken == "" {
		return fmt.Errorf("SLACK_BOT_TOKEN is required")
	}

	if c.SlackSigningSecret == "" {
		return fmt.Errorf("SLACK_SIGNING_SECRET is required")
	}

	return nil
}
