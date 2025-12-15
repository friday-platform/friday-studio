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
	"github.com/tempestteam/atlas/apps/signal-gateway/service"
	"github.com/tempestteam/atlas/pkg/metrics"
	"github.com/tempestteam/atlas/pkg/profiler"
	"github.com/tempestteam/atlas/pkg/server"
)

// GitCommit is the git commit hash set via ldflags at build time.
var GitCommit = "unknown"

func main() {
	// Load .env file if specified
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

	// Parse configuration
	cfg := service.Config{
		TLSConfig: &server.TLSConfig{},
	}
	if err := env.ParseWithOptions(&cfg, env.Options{}); err != nil {
		panic(err)
	}

	// Create service
	svc := service.New(cfg)

	// Get logger for main
	log := svc.GetLogger()

	// Start profiler
	if err := profiler.Start(cfg.Profiler, cfg.ServiceName, GitCommit, log.Logger); err != nil {
		log.Error("Failed to start profiler", "error", err)
	}

	// Initialize service
	err := svc.Init(context.Background())
	if err != nil {
		log.Error("Failed to initialize service", "error", err)
		os.Exit(1)
	}

	// Setup TLS before starting any servers
	if err := cfg.TLSConfig.SetupTLS(); err != nil {
		log.Error("Failed to setup TLS", "error", err)
		os.Exit(1)
	}

	// Start metrics server (shares TLS config with main server)
	metricsServer := metrics.StartServer(cfg.MetricsPort, cfg.TLSConfig)
	log.Info("Started metrics server", "port", cfg.MetricsPort)

	// Setup signal handling for graceful shutdown
	shutdownChan := make(chan os.Signal, 1)
	signal.Notify(shutdownChan, syscall.SIGTERM, syscall.SIGINT)

	// Start HTTP server
	serverCfg, serverErrors := svc.Serve()

	// Block until shutdown signal or server error
	select {
	case err := <-serverErrors:
		if err != nil {
			log.Error("Server error", "error", err)
			os.Exit(1)
		}
		log.Info("Server stopped")
		os.Exit(0)

	case sig := <-shutdownChan:
		log.Info("Received shutdown signal, starting graceful shutdown", "signal", sig)

		// Create shutdown context with 30 second timeout
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)

		// Shutdown metrics server
		if err := metrics.Shutdown(shutdownCtx, metricsServer); err != nil {
			log.Error("Error shutting down metrics server", "error", err)
		}

		// Graceful shutdown of HTTP server (stop accepting new requests)
		if serverCfg != nil && serverCfg.ShutdownFn != nil {
			if err := serverCfg.ShutdownFn(shutdownCtx); err != nil {
				log.Error("Error during graceful shutdown", "error", err)
				cancel()
				os.Exit(1)
			}
			log.Info("Graceful shutdown completed successfully")
		}

		// Close service resources AFTER HTTP server stopped
		if err := svc.Close(); err != nil {
			log.Error("Error closing service", "error", err)
		}

		cancel()
		os.Exit(0)
	}
}
