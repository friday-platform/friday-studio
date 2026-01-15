package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
	"github.com/tempestteam/atlas/apps/bounce/analytics"
	"github.com/tempestteam/atlas/apps/bounce/service"
	"github.com/tempestteam/atlas/pkg/metrics"
	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

// GitCommit is the git commit hash set via ldflags at build time.
var GitCommit = "unknown"

func main() {
	var err error

	if os.Getenv("DOT_ENV") != "" {
		err := godotenv.Load(os.Getenv("DOT_ENV"))
		if err != nil {
			fmt.Printf("no .env file found at - %s, using env vars\n", os.Getenv("DOT_ENV"))
		}
	} else {
		err := godotenv.Load()
		if err != nil {
			fmt.Println("no .env file found, using env vars")
		}
	}

	cfg := service.Config{
		TLSConfig: &server.TLSConfig{},
	}
	opts := env.Options{}
	if err := env.ParseWithOptions(&cfg, opts); err != nil {
		panic(err)
	}

	svc := service.New(cfg)

	// Start profiler before service initialization
	if err := profiler.Start(cfg.Profiler, cfg.ServiceName, GitCommit, svc.Logger.Logger); err != nil {
		svc.Logger.Error("Failed to start profiler", "error", err)
	}

	err = svc.Init()
	if err != nil {
		svc.Logger.Error("Failed to initialize service", "error", err)
		os.Exit(1)
	}

	// Setup TLS before starting any servers
	if err := cfg.TLSConfig.SetupTLS(); err != nil {
		svc.Logger.Error("Failed to setup TLS", "error", err)
		os.Exit(1)
	}

	// Initialize analytics with client TLS config
	if clientTLS, err := cfg.TLSConfig.ClientTLSConfig(); err != nil {
		svc.Logger.Error("Failed to get client TLS config for analytics", "error", err)
	} else {
		analytics.Init(clientTLS)
	}

	// Start metrics server (shares TLS config with main server)
	metricsServer := metrics.StartServer(cfg.MetricsPort, cfg.TLSConfig)
	svc.Logger.Info("Started metrics server", "port", cfg.MetricsPort)

	// Set up signal handling for graceful shutdown and operations
	shutdownChan := make(chan os.Signal, 1)
	signal.Notify(shutdownChan, syscall.SIGTERM, syscall.SIGINT)

	hupChan := make(chan os.Signal, 1)
	signal.Notify(hupChan, syscall.SIGHUP)

	go func() {
		for {
			sig := <-hupChan
			if sig == syscall.SIGHUP {
				svc.Logger.Info("Received SIGHUP signal")
			}
		}
	}()

	// Start server
	serverCfg, serverErrors := svc.Serve()

	// Block until shutdown signal or server error
	select {
	case err := <-serverErrors:
		if err != nil {
			svc.Logger.Error("Server error", "error", err)
			os.Exit(1)
		}
		// Server stopped cleanly (shouldn't normally happen)
		svc.Logger.Info("Server stopped")
		os.Exit(0)

	case sig := <-shutdownChan:
		svc.Logger.Info("Received shutdown signal, starting graceful shutdown", "signal", sig)

		// Create shutdown context with 30 second timeout
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)

		// Shutdown metrics server
		if err := metrics.Shutdown(shutdownCtx, metricsServer); err != nil {
			svc.Logger.Error("Error shutting down metrics server", "error", err)
		}

		// Call graceful shutdown
		if serverCfg != nil && serverCfg.ShutdownFn != nil {
			if err := serverCfg.ShutdownFn(shutdownCtx); err != nil {
				svc.Logger.Error("Error during graceful shutdown", "error", err)
				cancel()
				os.Exit(1)
			}
			svc.Logger.Info("Graceful shutdown completed successfully")
		}

		// Flush analytics events before shutdown
		if err := analytics.Shutdown(shutdownCtx); err != nil {
			svc.Logger.Error("Error shutting down analytics", "error", err)
		}

		// Close service resources
		if err := svc.Close(); err != nil {
			svc.Logger.Error("Error closing service", "error", err)
		}

		cancel()
		os.Exit(0)
	}
}
