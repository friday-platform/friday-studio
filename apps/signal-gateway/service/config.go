package service

import (
	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

// Config holds all configuration for the Signal Gateway service.
type Config struct {
	ServiceName string `env:"SERVICE_NAME" envDefault:"signal-gateway"`
	Port        string `env:"PORT" envDefault:"8080"`
	MetricsPort string `env:"METRICS_PORT" envDefault:"9090"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"info"`

	PostgresConnection string `env:"POSTGRES_CONNECTION" envDefault:"postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable"`

	AtlasURLTemplate    string `env:"ATLAS_URL_TEMPLATE" envDefault:"https://atlas-%s.atlas.svc.cluster.local"`
	AtlasTimeoutSeconds int    `env:"ATLAS_TIMEOUT_SECONDS" envDefault:"10"`

	RouteCacheTTLMinutes int `env:"ROUTE_CACHE_TTL_MINUTES" envDefault:"5"`

	TLSConfig *server.TLSConfig
	Profiler  profiler.Config
}
