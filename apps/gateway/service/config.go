package service

import (
	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

type Config struct {
	Port           string `env:"PORT" envDefault:"8080"`
	MetricsPort    string `env:"METRICS_PORT" envDefault:"9090"`
	LogLevel       string `env:"LOG_LEVEL" envDefault:"info"`
	ServiceName    string `env:"SERVICE_NAME" envDefault:"gateway"`
	SendGridAPIKey string `env:"SENDGRID_API_KEY,required"`
	ParallelAPIKey string `env:"PARALLEL_API_KEY,required"`
	JWTPublicKey   string `env:"JWT_PUBLIC_KEY_FILE,file,required"`

	TLSConfig *server.TLSConfig
	Profiler  profiler.Config
}
