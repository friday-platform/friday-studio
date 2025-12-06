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
	"github.com/tempestteam/atlas/apps/gist/service"
	"github.com/tempestteam/atlas/pkg/metrics"
	"github.com/tempestteam/atlas/pkg/server"
)

func main() {
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
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(1)
	}

	svc := service.New(cfg)

	ctx := context.Background()
	if err := svc.Init(ctx); err != nil {
		svc.Logger.Error("Failed to initialize service", "error", err)
		os.Exit(1)
	}

	// Setup TLS before starting any servers
	if err := cfg.TLSConfig.SetupTLS(); err != nil {
		svc.Logger.Error("Failed to setup TLS", "error", err)
		os.Exit(1)
	}

	// Start metrics server (shares TLS config with main server)
	metricsServer := metrics.StartServer(cfg.MetricsPort, cfg.TLSConfig)
	svc.Logger.Info("Started metrics server", "port", cfg.MetricsPort)

	shutdownChan := make(chan os.Signal, 1)
	signal.Notify(shutdownChan, syscall.SIGTERM, syscall.SIGINT)

	serverCfg, serverErrors := svc.Serve()

	select {
	case err := <-serverErrors:
		if err != nil {
			svc.Logger.Error("Server error", "error", err)
			os.Exit(1)
		}
		svc.Logger.Info("Server stopped")
		os.Exit(0)

	case sig := <-shutdownChan:
		svc.Logger.Info("Received shutdown signal, starting graceful shutdown", "signal", sig)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)

		if serverCfg != nil && serverCfg.ShutdownFn != nil {
			if err := serverCfg.ShutdownFn(shutdownCtx); err != nil {
				svc.Logger.Error("Error during graceful shutdown", "error", err)
				cancel()
				os.Exit(1)
			}
			svc.Logger.Info("Graceful shutdown completed successfully")
		}

		if err := metrics.Shutdown(shutdownCtx, metricsServer); err != nil {
			svc.Logger.Error("Error shutting down metrics server", "error", err)
		}

		if err := svc.Close(); err != nil {
			svc.Logger.Error("Error closing service", "error", err)
		}

		cancel()
		os.Exit(0)
	}
}
