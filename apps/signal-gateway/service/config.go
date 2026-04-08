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

	AtlasURLTemplate    string `env:"ATLAS_URL_TEMPLATE" envDefault:"https://atlas-%s.atlas.svc.cluster.local"`
	AtlasTimeoutSeconds int    `env:"ATLAS_TIMEOUT_SECONDS" envDefault:"10"`

	TLSConfig *server.TLSConfig
	Profiler  profiler.Config
}
