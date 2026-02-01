package service

import (
	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

type Config struct {
	Port                      string `env:"PORT" envDefault:"8090"`
	MetricsPort               string `env:"METRICS_PORT" envDefault:"9090"`
	LogLevel                  string `env:"LOG_LEVEL" envDefault:"info"`
	ServiceName               string `env:"SERVICE_NAME" envDefault:"persona"`
	PostgresConnection        string `env:"POSTGRES_CONNECTION,required"`
	LiteLLMPostgresConnection string `env:"LITELLM_POSTGRES_CONNECTION"`
	JWTPublicKey              string `env:"JWT_PUBLIC_KEY_FILE,file,required"`

	TLSConfig *server.TLSConfig
	Profiler  profiler.Config
}
