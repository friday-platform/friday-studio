package config

import (
	"log/slog"
	"os"
	"testing"
	"time"
)

func TestLoadConfig_Success(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Set up environment variables
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db")
	t.Setenv("RECONCILIATION_INTERVAL", "45s")
	t.Setenv("NAMESPACE", "atlas")
	t.Setenv("ARGOCD_NAMESPACE", "argocd")
	t.Setenv("ENVIRONMENT", "sandbox")
	t.Setenv("GIT_REPO_URL", "git@github.com:test/repo.git")
	t.Setenv("GIT_TARGET_REVISION", "main")
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("HEALTH_CHECK_PORT", "9090")
	t.Setenv("METRICS_PORT", "9091")
	t.Setenv("WEBHOOK_ENABLED", "true")
	t.Setenv("WEBHOOK_PORT", "9092")
	t.Setenv("WEBHOOK_TOKEN", "test-token")
	t.Setenv("TLS_CERTIFICATE_PATH", "/cert-volume/tls.crt")
	t.Setenv("TLS_KEY_PATH", "/cert-volume/tls.key")
	t.Setenv("TLS_CA_PATH", "/cert-volume/ca.crt")

	cfg, err := Load(logger)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if cfg.DatabaseURL != "postgresql://user:pass@localhost:5432/db" {
		t.Errorf("unexpected DatabaseURL: %s", cfg.DatabaseURL)
	}

	if cfg.ReconciliationInterval != 45*time.Second {
		t.Errorf("unexpected ReconciliationInterval: %v", cfg.ReconciliationInterval)
	}

	if cfg.Namespace != "atlas" {
		t.Errorf("unexpected Namespace: %s", cfg.Namespace)
	}

	if cfg.ArgoCDNamespace != "argocd" {
		t.Errorf("unexpected ArgoCDNamespace: %s", cfg.ArgoCDNamespace)
	}

	if cfg.Environment != "sandbox" {
		t.Errorf("unexpected Environment: %s", cfg.Environment)
	}

	if cfg.GitRepoURL != "git@github.com:test/repo.git" {
		t.Errorf("unexpected GitRepoURL: %s", cfg.GitRepoURL)
	}

	if cfg.GitTargetRevision != "main" {
		t.Errorf("unexpected GitTargetRevision: %s", cfg.GitTargetRevision)
	}

	if cfg.LogLevel != "debug" {
		t.Errorf("unexpected LogLevel: %s", cfg.LogLevel)
	}

	if cfg.HealthCheckPort != 9090 {
		t.Errorf("unexpected HealthCheckPort: %d", cfg.HealthCheckPort)
	}

	if cfg.MetricsPort != 9091 {
		t.Errorf("unexpected MetricsPort: %d", cfg.MetricsPort)
	}

	if !cfg.WebhookEnabled {
		t.Error("expected WebhookEnabled to be true")
	}

	if cfg.WebhookPort != 9092 {
		t.Errorf("unexpected WebhookPort: %d", cfg.WebhookPort)
	}

	if cfg.WebhookToken != "test-token" {
		t.Errorf("unexpected WebhookToken: %s", cfg.WebhookToken)
	}
}

func TestLoadConfig_Defaults(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Set only required fields
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db")
	t.Setenv("GIT_REPO_URL", "git@github.com:test/repo.git")
	t.Setenv("WEBHOOK_TOKEN", "") // Optional field, set to empty
	t.Setenv("TLS_CERTIFICATE_PATH", "/cert-volume/tls.crt")
	t.Setenv("TLS_KEY_PATH", "/cert-volume/tls.key")
	t.Setenv("TLS_CA_PATH", "/cert-volume/ca.crt")

	cfg, err := Load(logger)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// Check defaults
	if cfg.ReconciliationInterval != 30*time.Second {
		t.Errorf("expected default ReconciliationInterval 30s, got %v", cfg.ReconciliationInterval)
	}

	if cfg.Namespace != "atlas" {
		t.Errorf("expected default Namespace 'atlas', got %s", cfg.Namespace)
	}

	if cfg.ArgoCDNamespace != "argocd" {
		t.Errorf("expected default ArgoCDNamespace 'argocd', got %s", cfg.ArgoCDNamespace)
	}

	if cfg.Environment != "sandbox" {
		t.Errorf("expected default Environment 'sandbox', got %s", cfg.Environment)
	}

	if cfg.GitTargetRevision != "HEAD" {
		t.Errorf("expected default GitTargetRevision 'HEAD', got %s", cfg.GitTargetRevision)
	}

	if cfg.LogLevel != "info" {
		t.Errorf("expected default LogLevel 'info', got %s", cfg.LogLevel)
	}

	if cfg.HealthCheckPort != 8080 {
		t.Errorf("expected default HealthCheckPort 8080, got %d", cfg.HealthCheckPort)
	}

	if cfg.MetricsPort != 9090 {
		t.Errorf("expected default MetricsPort 9090, got %d", cfg.MetricsPort)
	}

	if !cfg.WebhookEnabled {
		t.Error("expected default WebhookEnabled to be true")
	}

	if cfg.WebhookPort != 8082 {
		t.Errorf("expected default WebhookPort 8082, got %d", cfg.WebhookPort)
	}
}

func TestValidate_Success(t *testing.T) {
	cfg := &Config{
		DatabaseURL:            "postgresql://user:pass@localhost:5432/db",
		GitRepoURL:             "git@github.com:test/repo.git",
		Environment:            "sandbox",
		ReconciliationInterval: 30 * time.Second,
		HealthCheckPort:        8080,
		MetricsPort:            9090,
		WebhookPort:            8082,
	}

	err := cfg.Validate()
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
}

func TestValidate_InvalidPortRange(t *testing.T) {
	tests := []struct {
		name        string
		port        int
		portName    string
		shouldError bool
	}{
		{"valid port 8080", 8080, "HealthCheckPort", false},
		{"valid port 1", 1, "HealthCheckPort", false},
		{"valid port 65535", 65535, "HealthCheckPort", false},
		{"invalid port 0", 0, "HealthCheckPort", true},
		{"invalid port -1", -1, "HealthCheckPort", true},
		{"invalid port 65536", 65536, "HealthCheckPort", true},
		{"invalid port 70000", 70000, "HealthCheckPort", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &Config{
				DatabaseURL:            "postgresql://user:pass@localhost:5432/db",
				GitRepoURL:             "git@github.com:test/repo.git",
				Environment:            "sandbox",
				ReconciliationInterval: 30 * time.Second,
				HealthCheckPort:        8080,
				MetricsPort:            9090,
				WebhookPort:            8082,
			}

			// Set the port we're testing
			switch tt.portName {
			case "HealthCheckPort":
				cfg.HealthCheckPort = tt.port
			case "MetricsPort":
				cfg.MetricsPort = tt.port
			case "WebhookPort":
				cfg.WebhookPort = tt.port
			}

			err := cfg.Validate()
			if tt.shouldError && err == nil {
				t.Errorf("expected error for port %d, got nil", tt.port)
			}
			if !tt.shouldError && err != nil {
				t.Errorf("expected no error for port %d, got %v", tt.port, err)
			}
		})
	}
}

// Note: Port conflict validation is not currently implemented in the Validate function
// If needed in the future, add validation to ensure HealthCheckPort, MetricsPort, and WebhookPort are unique
