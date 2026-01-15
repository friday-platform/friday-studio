package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"go.opentelemetry.io/collector/config/configtls"
)

func (c *Config) Listen(ctx context.Context) error {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	// Use configured WriteTimeout or default to 30 seconds
	writeTimeout := c.WriteTimeout
	if writeTimeout == 0 {
		writeTimeout = 30 * time.Second
	}

	srv := &http.Server{
		Addr:              ":" + c.Port,
		Handler:           c.Handler,
		TLSConfig:         c.TLSConfig.GetTLSConfig(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      writeTimeout,
	}

	if srv.TLSConfig != nil {
		srv.TLSConfig = c.TLSConfig.GetTLSConfig()
		logger.Info("Starting server with TLS", "port", c.Port)
		return srv.ListenAndServeTLS("", "")
	}

	c.ShutdownFn = srv.Shutdown

	logger.Info("Starting server without TLS", "port", c.Port)
	return srv.ListenAndServe()
}

func (c *TLSConfig) SetupTLS() error {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	if c.config != nil {
		logger.Warn("TLS config already set up, skipping")
		return nil
	}

	if c.CertPath == "" || c.KeyPath == "" {
		logger.Warn("missing environment variables for server key/cert; skipping TLS")
		return nil
	}

	cfg := configtls.NewDefaultServerConfig()
	cfg.ReloadInterval = 24 * time.Hour
	cfg.CertFile = c.CertPath
	cfg.KeyFile = c.KeyPath
	cfg.MinVersion = "1.3"

	if c.CAPath != "" {
		cfg.CAFile = c.CAPath
		cfg.ClientCAFile = c.CAPath
	}

	config, err := cfg.LoadTLSConfig(context.TODO())
	if err != nil {
		return fmt.Errorf("failed to load TLS config: %w", err)
	}

	// This is the default in tls.Config
	// configtls sets that to require and verify client cert
	// if ClientCAFile is set. We need to reset it to NoClientCert
	// we have a separate field for that
	config.ClientAuth = tls.NoClientCert

	if c.EnableClientAuth {
		config.ClientAuth = tls.RequireAndVerifyClientCert
	}

	c.config = config

	return nil
}

func (c *TLSConfig) GetTLSConfig() *tls.Config {
	return c.config
}

func (c *TLSConfig) GetRootCA() (*x509.CertPool, error) {
	rootCAs := x509.NewCertPool()

	if c.CAPath != "" {
		// Load root CA certificate from disk
		rootCertData, err := os.ReadFile(c.CAPath)
		if err != nil {
			return nil, fmt.Errorf("failed to load server key/cert pair: %w", err)
		}

		if ok := rootCAs.AppendCertsFromPEM(rootCertData); !ok {
			return nil, fmt.Errorf("failed to append CA certs")
		}
	}

	return rootCAs, nil
}

// ClientTLSConfig returns a TLS config for outbound client connections.
// Uses the same CA certificate as the server for verifying peer certificates.
func (c *TLSConfig) ClientTLSConfig() (*tls.Config, error) {
	if c.CAPath == "" {
		return nil, nil
	}

	rootCAs, err := c.GetRootCA()
	if err != nil {
		return nil, err
	}

	return &tls.Config{
		RootCAs:    rootCAs,
		MinVersion: tls.VersionTLS12,
	}, nil
}
