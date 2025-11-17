package server

import (
	"context"
	"crypto/tls"
	"net/http"
	"time"
)

type Config struct {
	Port         string
	Handler      http.Handler
	TLSConfig    *TLSConfig
	ShutdownFn   func(context.Context) error
	WriteTimeout time.Duration // Configurable write timeout, defaults to 30s if not set
}

type TLSConfig struct {
	CertPath         string `env:"TLS_CERTIFICATE_PATH"`
	EnableClientAuth bool   `env:"TLS_ENABLE_CLIENT_AUTH" envDefault:"false"`
	KeyPath          string `env:"TLS_KEY_PATH"`
	CAPath           string `env:"TLS_CA_PATH"`
	config           *tls.Config
}
