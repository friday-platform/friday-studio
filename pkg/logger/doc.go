// Package logger is the atlas-flavored Go logger. It wraps log/slog
// with an API shape that mirrors the TS @atlas/logger package so an
// engineer switching between the TS and Go sides sees the same idiom
// (Trace/Debug/Info/Warn/Error/Fatal level methods, Child for merged
// context).
//
// Output is JSON to stderr by default. Process-compose's stderr capture
// in friday-launcher routes each binary's logs to ~/.friday/local/logs/
// so all atlas Go binaries produce uniform JSON in the same place.
//
// Level is read from ATLAS_LOG_LEVEL (trace|debug|info|warn|error|fatal),
// defaulting to "info". The component name passed to New() is included
// as the first kv pair on every log line so log aggregators can
// reliably partition.
//
// Usage:
//
//	log := logger.New("webhook-tunnel")
//	log.Info("listening", "port", 9090)
//	child := log.Child("provider", "github")
//	child.Warn("rate limit hit", "retry_after_ms", 5000)
//	log.Fatal("config invalid", "error", err) // logs then os.Exit(1)
package logger
