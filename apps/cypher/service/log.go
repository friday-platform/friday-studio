package service

import (
	"log/slog"
	"time"

	"github.com/go-chi/httplog/v2"
	xlog "github.com/tempestteam/atlas/pkg/x/log"
)

// Logger creates and returns a structured HTTP logger for the service.
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
	}

	return httplog.NewLogger(cfg.ServiceName, logOpts)
}
