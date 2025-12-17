package config

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
	"github.com/tempestteam/atlas/pkg/profiler"
)

// Config holds the operator configuration.
type Config struct {
	// Database Configuration
	DatabaseURL string `env:"DATABASE_URL,required"`

	// Operator Configuration
	ReconciliationInterval time.Duration `env:"RECONCILIATION_INTERVAL" envDefault:"30s"`
	Namespace              string        `env:"NAMESPACE" envDefault:"atlas"`
	ArgoCDNamespace        string        `env:"ARGOCD_NAMESPACE" envDefault:"argocd"`
	Environment            string        `env:"ENVIRONMENT" envDefault:"sandbox"`

	// ArgoCD Repository Configuration
	GitRepoURL        string `env:"GIT_REPO_URL,required"`
	GitTargetRevision string `env:"GIT_TARGET_REVISION" envDefault:"HEAD"`

	// Logging
	LogLevel string `env:"LOG_LEVEL" envDefault:"info"`

	// Health Check
	HealthCheckPort int `env:"HEALTH_CHECK_PORT" envDefault:"8080"`
	MetricsPort     int `env:"METRICS_PORT" envDefault:"9090"`

	// Webhook Configuration
	WebhookEnabled bool   `env:"WEBHOOK_ENABLED" envDefault:"true"`
	WebhookPort    int    `env:"WEBHOOK_PORT" envDefault:"8082"`
	WebhookToken   string `env:"WEBHOOK_TOKEN"` // Optional: Bearer token for authentication

	// Pool Configuration
	PoolEnabled    bool `env:"POOL_ENABLED" envDefault:"true"`
	PoolTargetSize int  `env:"POOL_TARGET_SIZE" envDefault:"5"`

	// LiteLLM Configuration
	LiteLLMEnabled        bool    `env:"LITELLM_ENABLED" envDefault:"false"`
	LiteLLMEndpoint       string  `env:"LITELLM_ENDPOINT" envDefault:"http://litellm-proxy.atlas-operator.svc.cluster.local:4000"`
	LiteLLMMasterKey      string  `env:"LITELLM_MASTER_KEY" envDefault:""`
	LiteLLMDefaultBudget  float64 `env:"LITELLM_DEFAULT_BUDGET" envDefault:"200.0"`
	LiteLLMBudgetDuration string  `env:"LITELLM_BUDGET_DURATION" envDefault:"30d"`

	// Cypher Configuration (for encrypting virtual keys)
	CypherEndpoint string `env:"CYPHER_ENDPOINT" envDefault:"https://atlas-cypher.atlas-operator.svc.cluster.local:8085"`

	// Profiler Configuration
	Profiler profiler.Config
}

// Load loads configuration from environment variables.
func Load(logger *slog.Logger) (*Config, error) {
	// Check if DOT_ENV is set (following tempest-core pattern)
	if dotenv := os.Getenv("DOT_ENV"); dotenv != "" {
		logger.Info("Loading environment from file", "path", dotenv)
		err := godotenv.Load(dotenv)
		if err != nil {
			// Not finding the file is not fatal, just log
			logger.Info("No .env file found", "requested", dotenv, "error", err)
		}
	}

	// Parse environment variables into Config struct
	cfg := &Config{}
	if err := env.ParseWithOptions(cfg, env.Options{
		RequiredIfNoDef: true,
	}); err != nil {
		return nil, fmt.Errorf("failed to parse environment: %w", err)
	}

	// Log configuration (without sensitive values)
	logger.Info("Configuration loaded",
		"reconciliation_interval", cfg.ReconciliationInterval,
		"namespace", cfg.Namespace,
		"argocd_namespace", cfg.ArgoCDNamespace,
		"environment", cfg.Environment,
		"git_repo_url", cfg.GitRepoURL,
		"git_target_revision", cfg.GitTargetRevision,
		"log_level", cfg.LogLevel,
		"health_check_port", cfg.HealthCheckPort,
		"metrics_port", cfg.MetricsPort,
		"webhook_enabled", cfg.WebhookEnabled,
		"webhook_port", cfg.WebhookPort,
		"webhook_auth", cfg.WebhookToken != "",
		"litellm_enabled", cfg.LiteLLMEnabled,
		"litellm_endpoint", cfg.LiteLLMEndpoint,
		"litellm_default_budget", cfg.LiteLLMDefaultBudget,
		"litellm_budget_duration", cfg.LiteLLMBudgetDuration,
		"cypher_endpoint", cfg.CypherEndpoint,
	)

	return cfg, nil
}

// Validate performs additional validation on the configuration.
func (c *Config) Validate() error {
	// Validate environment is either sandbox or production
	if c.Environment != "sandbox" && c.Environment != "production" {
		return fmt.Errorf("invalid environment: %s (must be 'sandbox' or 'production')", c.Environment)
	}

	// Validate reconciliation interval is reasonable
	if c.ReconciliationInterval < 10*time.Second {
		return fmt.Errorf("reconciliation interval too short: %v (minimum 10s)", c.ReconciliationInterval)
	}
	if c.ReconciliationInterval > 5*time.Minute {
		return fmt.Errorf("reconciliation interval too long: %v (maximum 5m)", c.ReconciliationInterval)
	}

	// Validate ports
	if c.HealthCheckPort <= 0 || c.HealthCheckPort > 65535 {
		return fmt.Errorf("invalid health check port: %d", c.HealthCheckPort)
	}
	if c.MetricsPort <= 0 || c.MetricsPort > 65535 {
		return fmt.Errorf("invalid metrics port: %d", c.MetricsPort)
	}
	if c.WebhookEnabled && (c.WebhookPort <= 0 || c.WebhookPort > 65535) {
		return fmt.Errorf("invalid webhook port: %d", c.WebhookPort)
	}

	// Validate LiteLLM configuration
	if c.LiteLLMEnabled {
		if c.LiteLLMMasterKey == "" {
			return fmt.Errorf("LITELLM_MASTER_KEY is required when LITELLM_ENABLED=true")
		}
		if c.LiteLLMDefaultBudget <= 0 {
			return fmt.Errorf("LITELLM_DEFAULT_BUDGET must be positive")
		}
	}

	return nil
}

// GetLogLevel returns the slog.Level based on the configured log level.
func (c *Config) GetLogLevel() slog.Level {
	switch c.LogLevel {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
