package service

import "github.com/tempestteam/atlas/pkg/server"

type Config struct {
	Port        string `env:"PORT" envDefault:"8085"`
	MetricsPort string `env:"METRICS_PORT" envDefault:"9090"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"info"`
	ServiceName string `env:"SERVICE_NAME" envDefault:"cortex"`

	GCSBucket         string `env:"GCS_BUCKET,required"`
	ServiceAccountKey string `env:"SERVICE_ACCOUNT_KEY_FILE"`

	PostgresConnection string `env:"POSTGRES_CONNECTION" envDefault:"postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable"`

	JWTPublicKeyFile string `env:"JWT_PUBLIC_KEY_FILE,required"`

	MaxUploadSize        int64 `env:"MAX_UPLOAD_SIZE" envDefault:"104857600"` // 100MB
	MaxConcurrentUploads int   `env:"MAX_CONCURRENT_UPLOADS" envDefault:"50"` // Limit concurrent uploads to prevent OOM

	TLSConfig *server.TLSConfig
}
