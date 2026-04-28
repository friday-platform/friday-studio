package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// startupErrorLogFallback is the bare filename used when the
// primary log path under ~/.friday/local/logs is not writable.
// Falls under os.TempDir().
const startupErrorLogFallback = "friday-launcher-startup.log"

// writeStartupErrorLog writes a single human-readable diagnostic
// entry to disk so the user has something to attach when reporting
// "Friday Studio wouldn't start". Per Decision #34:
//   - Primary path: ~/.friday/local/logs/launcher-startup.log
//   - Fallback (mkdir failed): os.TempDir()/friday-launcher-startup.log
//
// Append mode: repeated startup failures accumulate so support can
// see the history. Best-effort: if both paths fail (read-only FS,
// extreme), returns "" and the caller's dialog still shows without
// a log path embedded in the body.
//
// `details` is a free-form key→value map. Common keys: missing,
// bin_dir, exe, port, os. Order is not preserved (map iteration);
// callers don't depend on a specific layout.
//
// Cross-platform: same body across darwin / windows / linux. Each
// platform's preflight_dialog_*.go consumes the returned path.
func writeStartupErrorLog(reason string, details map[string]string) string {
	logPath := startupErrorLogPath()
	if logPath == "" {
		return ""
	}
	// logPath is constructed entirely from os.UserHomeDir + a
	// hardcoded filename, never from user input — gosec G304
	// "potential file inclusion" is a false positive here.
	f, err := os.OpenFile( //nolint:gosec // G304: launcher-controlled path
		logPath,
		os.O_CREATE|os.O_WRONLY|os.O_APPEND,
		0o644,
	)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()

	// Best-effort writes — if the log fd has been closed (extreme:
	// disk-full mid-write), we still want to fall through so the
	// caller's dialog renders even without a log path embedded.
	_, _ = fmt.Fprintf(f, "%s startup error: %s\n",
		time.Now().UTC().Format(time.RFC3339), reason)
	for k, v := range details {
		_, _ = fmt.Fprintf(f, "  %s: %s\n", k, v)
	}
	_, _ = fmt.Fprintln(f, "")
	return logPath
}

// startupErrorLogPath returns the path we'll write to. Tries the
// primary path's mkdir first; on any error falls back to TempDir.
// Returns "" only if BOTH paths are unwritable (we don't try
// further fallbacks — the dialog will just lack a log path line).
func startupErrorLogPath() string {
	home, err := os.UserHomeDir()
	if err == nil {
		dir := filepath.Join(home, ".friday", "local", "logs")
		// 0o755: the launcher's normal logs dir uses world-readable
		// perms so support tooling and `tail` work without sudo;
		// gosec's stricter 0750 default would break that pattern.
		if err := os.MkdirAll(dir, 0o755); err == nil { //nolint:gosec // G301: matches existing logs/ perms
			return filepath.Join(dir, "launcher-startup.log")
		}
	}
	tmp := os.TempDir()
	if tmp == "" {
		return ""
	}
	return filepath.Join(tmp, startupErrorLogFallback)
}
