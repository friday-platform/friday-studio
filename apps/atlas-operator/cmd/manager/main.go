package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tempestteam/atlas/apps/atlas-operator/internal/controller"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/argocd"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/config"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/database"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/pool"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/webhook"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var (
	// GitCommit is the git commit hash set via ldflags at build time.
	GitCommit = "unknown"
	// GitRef is the git ref set via ldflags at build time.
	GitRef = "unknown"

	// Prometheus metrics.
	buildInfo = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "atlas_operator_build_info",
			Help: "Build information with git commit and ref",
		},
		[]string{"git_commit", "git_ref"},
	)
	reconciliationDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "atlas_operator_reconciliation_duration_seconds",
			Help: "Time taken for reconciliation",
		},
		[]string{"status"},
	)
	usersTotal = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "atlas_operator_users_total",
			Help: "Total number of users being managed",
		},
	)
	applicationsCreatedTotal = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "atlas_operator_applications_created_total",
			Help: "Total number of applications created",
		},
	)
	applicationsDeletedTotal = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "atlas_operator_applications_deleted_total",
			Help: "Total number of applications deleted",
		},
	)
	errorsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "atlas_operator_errors_total",
			Help: "Total errors by type",
		},
		[]string{"type"},
	)
)

func init() {
	// Register Prometheus metrics
	prometheus.MustRegister(buildInfo)
	prometheus.MustRegister(reconciliationDuration)
	prometheus.MustRegister(usersTotal)
	prometheus.MustRegister(applicationsCreatedTotal)
	prometheus.MustRegister(applicationsDeletedTotal)
	prometheus.MustRegister(errorsTotal)
}

func main() {
	if err := run(); err != nil {
		slog.Error("Fatal error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	// Initialize structured logger
	logOpts := &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Format time in RFC3339
			if a.Key == slog.TimeKey {
				if t, ok := a.Value.Any().(time.Time); ok {
					a.Value = slog.StringValue(t.Format(time.RFC3339))
				}
			}
			return a
		},
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, logOpts))
	slog.SetDefault(logger)

	// Set build info metric
	buildInfo.WithLabelValues(GitCommit, GitRef).Set(1)

	logger.Info("Starting Atlas User Operator",
		"git_commit", GitCommit,
		"git_ref", GitRef,
	)

	// Load configuration
	cfg, err := config.Load(logger)
	if err != nil {
		return fmt.Errorf("failed to load configuration: %w", err)
	}

	// Validate configuration
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	// Update logger level based on config
	logOpts.Level = cfg.GetLogLevel()
	logger = slog.New(slog.NewJSONHandler(os.Stdout, logOpts))
	slog.SetDefault(logger)

	// Create database client
	dbClient, err := database.NewClient(cfg.DatabaseURL, logger)
	if err != nil {
		return fmt.Errorf("failed to create database client: %w", err)
	}
	defer func() {
		if err := dbClient.Close(); err != nil {
			logger.Error("Failed to close database client", "error", err)
		}
	}()

	// Create Kubernetes config
	kubeConfig, err := getKubeConfig()
	if err != nil {
		return fmt.Errorf("failed to get Kubernetes config: %w", err)
	}

	// Create ArgoCD manager
	argoCDManager, err := argocd.NewManager(
		kubeConfig,
		cfg.ArgoCDNamespace,
		"atlas", // Single namespace for all users
		cfg.Environment,
		cfg.GitRepoURL,
		cfg.GitTargetRevision,
		logger,
	)
	if err != nil {
		return fmt.Errorf("failed to create ArgoCD manager: %w", err)
	}

	// Create pool manager if enabled
	var poolManager *pool.Manager
	if cfg.PoolEnabled {
		poolManager = pool.NewManager(dbClient, cfg.PoolTargetSize, logger)
	}

	// Create reconciler
	reconciler := controller.NewReconciler(dbClient, argoCDManager, poolManager, cfg, logger)

	// Start health check server
	healthServer := startHealthServer(cfg.HealthCheckPort, reconciler, logger)

	// Start metrics server
	metricsServer := startMetricsServer(cfg.MetricsPort, logger)

	// Start webhook server if enabled
	var webhookServer *webhook.Server
	if cfg.WebhookEnabled {
		webhookServer = webhook.NewServer(reconciler, cfg.WebhookToken, logger)
		go func() {
			if err := webhookServer.Start(cfg.WebhookPort); err != nil {
				logger.Error("Webhook server failed", "error", err)
			}
		}()
	}

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Start reconciliation loop in background
	go func() {
		if err := reconciler.Start(ctx); err != nil {
			logger.Error("Reconciler stopped with error", "error", err)
		}
	}()

	// Wait for shutdown signal
	sig := <-sigChan
	logger.Info("Received shutdown signal", "signal", sig)

	// Graceful shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	reconciler.Stop()

	// Shutdown webhook server if running
	if webhookServer != nil {
		if err := webhookServer.Shutdown(shutdownCtx); err != nil {
			logger.Error("Failed to shutdown webhook server", "error", err)
		}
	}

	// Shutdown health server
	if err := healthServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("Failed to shutdown health server", "error", err)
	}

	// Shutdown metrics server
	if err := metricsServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("Failed to shutdown metrics server", "error", err)
	}

	logger.Info("Atlas User Operator stopped")
	return nil
}

// getKubeConfig returns a Kubernetes config.
func getKubeConfig() (*rest.Config, error) {
	// Try in-cluster config first
	cfg, err := rest.InClusterConfig()
	if err == nil {
		return cfg, nil
	}

	// Fall back to kubeconfig
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		kubeconfig = os.Getenv("HOME") + "/.kube/config"
	}

	cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return nil, fmt.Errorf("failed to build config: %w", err)
	}

	return cfg, nil
}

// startHealthServer starts the health check server.
func startHealthServer(port int, reconciler *controller.Reconciler, logger *slog.Logger) *http.Server {
	mux := http.NewServeMux()

	// Liveness probe
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})

	// Readiness probe
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := reconciler.Health(); err != nil {
			logger.Error("Health check failed", "error", err)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("Starting health server", "port", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("Health server failed", "error", err)
		}
	}()

	return server
}

// startMetricsServer starts the Prometheus metrics server.
func startMetricsServer(port int, logger *slog.Logger) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("Starting metrics server", "port", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("Metrics server failed", "error", err)
		}
	}()

	return server
}
