// Path: pkg/x/log/level.go
package xlog

import (
	"log/slog"
	"strings"
)

// LogLevelFromString parses a string representation of a log level into a slog.Level.
// It defaults to slog.LevelDebug if parsing fails or the level is unknown.
func LogLevelFromString(levelStr string) slog.Level {
	// slog level constants are uppercase (e.g., "DEBUG", "INFO")
	levelStr = strings.ToUpper(levelStr)

	switch levelStr {
	case "DEBUG":
		return slog.LevelDebug
	case "INFO":
		return slog.LevelInfo
	case "WARN", "WARNING": // Allow "WARNING" as well
		return slog.LevelWarn
	case "ERROR":
		return slog.LevelError
	default:
		// Default to Debug as requested in the original function proposal
		return slog.LevelDebug
	}
}
