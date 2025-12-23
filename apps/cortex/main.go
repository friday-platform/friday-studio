package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
	"github.com/tempestteam/atlas/apps/cortex/service"
	"github.com/tempestteam/atlas/pkg/metrics"
	"github.com/tempestteam/atlas/pkg/server"
)

func main() {
	if os.Getenv("DOT_ENV") != "" {
		err := godotenv.Load(os.Getenv("DOT_ENV"))
		if err != nil {
			fmt.Printf("no .env file found at %s, using env vars\n", os.Getenv("DOT_ENV"))
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
	if err := env.Parse(&cfg); err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(1)
	}

	svc, err := service.New(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to create service: %v\n", err)
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

	// Main server
	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           svc.Router(),
		TLSConfig:         cfg.TLSConfig.GetTLSConfig(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Channel to catch server errors
	serverErr := make(chan error, 1)

	go func() {
		var err error
		if httpServer.TLSConfig != nil {
			svc.Logger.Info("Starting cortex service with TLS", "port", cfg.Port)
			err = httpServer.ListenAndServeTLS("", "")
		} else {
			svc.Logger.Info("Starting cortex service", "port", cfg.Port)
			err = httpServer.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			svc.Logger.Error("server error", "error", err)
			serverErr <- err
		}
	}()

	// Wait for interrupt signal or server error
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErr:
		svc.Logger.Error("Server died unexpectedly", "error", err)
		os.Exit(1)
	case sig := <-quit:
		svc.Logger.Info("Received shutdown signal", "signal", sig)
	}

	// Graceful shutdown with timeout
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		svc.Logger.Error("Server shutdown error", "error", err)
	}

	if err := metrics.Shutdown(shutdownCtx, metricsServer); err != nil {
		svc.Logger.Error("Metrics server shutdown error", "error", err)
	}

	if err := svc.Close(); err != nil {
		svc.Logger.Error("Service close error", "error", err)
	}

	svc.Logger.Info("Servers stopped gracefully")
}
