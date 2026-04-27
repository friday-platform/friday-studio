package logger

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// LevelTrace and LevelFatal extend slog's built-in levels with the
// trace/fatal levels @atlas/logger TS exposes. Slog allows custom
// integer levels in the gap between info/error so we just pick numbers
// that sort correctly.
const (
	LevelTrace = slog.Level(-8) // below Debug (-4)
	LevelFatal = slog.Level(12) // above Error (8)
)

// Logger is the atlas Go logger. Wraps a *slog.Logger; the public
// surface is the level methods + Child.
type Logger struct {
	sl *slog.Logger
}

// New creates a Logger named after the given component. The component
// name is prefixed to every log line (key=component) so aggregators
// can partition cleanly. Level is read from ATLAS_LOG_LEVEL env at
// New() time. Writes to os.Stderr.
func New(component string) *Logger {
	return NewWithWriter(component, os.Stderr)
}

// NewWithWriter is like New but writes to the given writer. Use this
// when you need to multiplex stderr with another sink (e.g. the
// launcher's lumberjack-rotated launcher.log).
func NewWithWriter(component string, w io.Writer) *Logger {
	level := levelFromEnv()
	handler := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// Map our custom levels to readable string labels.
			if a.Key == slog.LevelKey {
				if lv, ok := a.Value.Any().(slog.Level); ok {
					switch lv {
					case LevelTrace:
						return slog.String(slog.LevelKey, "TRACE")
					case LevelFatal:
						return slog.String(slog.LevelKey, "FATAL")
					}
				}
			}
			return a
		},
	})
	sl := slog.New(handler).With("component", component)
	return &Logger{sl: sl}
}

// levelFromEnv parses ATLAS_LOG_LEVEL into a slog.Level. Unknown values
// fall back to info silently — log-init shouldn't be a place to fail
// the whole binary.
func levelFromEnv() slog.Level {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ATLAS_LOG_LEVEL"))) {
	case "trace":
		return LevelTrace
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	case "fatal":
		return LevelFatal
	default:
		return slog.LevelInfo
	}
}

// Trace logs at the trace level. Trace is the noisiest level; use it
// for fine-grained tracing that's normally disabled.
func (l *Logger) Trace(msg string, kv ...any) {
	l.sl.Log(context.Background(), LevelTrace, msg, kv...)
}

// Debug logs at the debug level.
func (l *Logger) Debug(msg string, kv ...any) {
	l.sl.Debug(msg, kv...)
}

// Info logs at the info level.
func (l *Logger) Info(msg string, kv ...any) {
	l.sl.Info(msg, kv...)
}

// Warn logs at the warn level.
func (l *Logger) Warn(msg string, kv ...any) {
	l.sl.Warn(msg, kv...)
}

// Error logs at the error level.
func (l *Logger) Error(msg string, kv ...any) {
	l.sl.Error(msg, kv...)
}

// Fatal logs at the fatal level then calls os.Exit(1). The exit is
// intentional: Fatal callers are saying "this is unrecoverable, drop
// the process now." Use Error if you want to log+continue.
func (l *Logger) Fatal(msg string, kv ...any) {
	l.sl.Log(context.Background(), LevelFatal, msg, kv...)
	os.Exit(1)
}

// Child returns a new Logger with the given key/value pairs merged
// into its base context. Useful for per-request or per-component
// sub-loggers — the parent context is preserved on every child line.
func (l *Logger) Child(kv ...any) *Logger {
	return &Logger{sl: l.sl.With(kv...)}
}
