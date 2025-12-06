package service

import "github.com/tempestteam/atlas/pkg/server"

type Config struct {
	Port               string `env:"PORT" envDefault:"8084"`
	MetricsPort        string `env:"METRICS_PORT" envDefault:"9090"`
	LogLevel           string `env:"LOG_LEVEL" envDefault:"debug"`
	ServiceName        string `env:"SERVICE_NAME" envDefault:"gist"`
	GCSBucket          string `env:"GCS_BUCKET,required"`
	ShareBaseURL       string `env:"SHARE_BASE_URL,required"`
	ServiceAccountKey  string `env:"SERVICE_ACCOUNT_KEY_FILE" envDefault:""`
	MaxUploadSize      int64  `env:"MAX_UPLOAD_SIZE" envDefault:"10485760"`
	CORSAllowedOrigins string `env:"CORS_ALLOWED_ORIGINS" envDefault:"*"`

	TLSConfig *server.TLSConfig
}
