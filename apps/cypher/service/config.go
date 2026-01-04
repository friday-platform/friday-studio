package service

import (
	"fmt"

	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

// Config holds the configuration for the cypher service.
type Config struct {
	// Server
	Port        string `env:"PORT" envDefault:"8085"`
	MetricsPort string `env:"METRICS_PORT" envDefault:"9090"`
	ServiceName string `env:"SERVICE_NAME" envDefault:"cypher"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"debug"`

	// Database
	PostgresConnection string `env:"POSTGRES_CONNECTION" envDefault:"postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable&search_path=cypher"`

	// Cache
	CacheSize int `env:"CACHE_SIZE" envDefault:"10000"`

	// KMS
	KMSProvider     string `env:"KMS_PROVIDER" envDefault:"fake"` // googlekms or fake
	GoogleKMSKeyURI string `env:"GOOGLE_KMS_KEY_URI"`
	// Note: In GKE, credentials come from Workload Identity automatically.
	// For local dev, use GOOGLE_APPLICATION_CREDENTIALS env var (standard).

	// JWT
	// PEM-encoded public key for JWT verification. If empty, tokens are parsed
	// without signature verification (for local dev behind traefik).
	// In Kubernetes, set JWT_PUBLIC_KEY_FILE to point to the mounted secret file.
	JWTPublicKey string `env:"JWT_PUBLIC_KEY_FILE,file" envDefault:""`
	// PEM-encoded private key for JWT signing. If empty, /api/atlas-token is not registered.
	// In Kubernetes, set JWT_PRIVATE_KEY_FILE to point to the mounted secret file.
	JWTPrivateKey string `env:"JWT_PRIVATE_KEY_FILE,file" envDefault:""`

	// TLS
	TLSConfig *server.TLSConfig
	Profiler  profiler.Config
}

// Validate checks the configuration for required fields based on provider.
func (c *Config) Validate() error {
	if c.KMSProvider == "googlekms" && c.GoogleKMSKeyURI == "" {
		return fmt.Errorf("GOOGLE_KMS_KEY_URI is required when KMS_PROVIDER=googlekms")
	}

	if c.KMSProvider != "googlekms" && c.KMSProvider != "fake" {
		return fmt.Errorf("KMS_PROVIDER must be 'googlekms' or 'fake', got: %s", c.KMSProvider)
	}

	return nil
}
