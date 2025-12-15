package service

import (
	"log/slog"
	"time"

	"github.com/go-chi/httplog/v2"
	xlog "github.com/tempestteam/atlas/pkg/x/log"
)

// Logger creates a new httplog logger with standard configuration.
func Logger(cfg Config) *httplog.Logger {
	cfgLogLevel := xlog.LogLevelFromString(cfg.LogLevel)

	logOpts := httplog.Options{
		LogLevel:        cfgLogLevel,
		JSON:            true,
		LevelFieldName:  "severity",
		TimeFieldFormat: time.RFC3339,
		SourceFieldName: "sloc",
	}

	if cfgLogLevel == slog.LevelDebug {
		logOpts.Concise = true
		logOpts.RequestHeaders = true
	}

	logOpts.Tags = map[string]string{
		"service": cfg.ServiceName,
	}

	return httplog.NewLogger(cfg.ServiceName, logOpts)
}
