//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// startupErrorButtonQuit is the label osascript uses both to render
// and to identify which button the user clicked. Match exactly with
// parseClickedButton's lookup. Stack 3 adds the missing-binaries
// variant which introduces a second "Open download page" button.
const startupErrorButtonQuit = "Quit"

// startupErrorLogPrimary is `~/.friday/local/logs/launcher-startup.log`
// — the same dir as the launcher's normal log files. Decision #34:
// co-located with logs, predictable path the user already knows.
// startupErrorLogFallback is `os.TempDir()/friday-launcher-startup.log`
// — used when the primary path's mkdir fails (broken install with
// a non-writable ~/.friday).
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
func writeStartupErrorLog(reason string, details map[string]string) string {
	logPath := startupErrorLogPath()
	if logPath == "" {
		return ""
	}
	// logPath is constructed entirely from os.UserHomeDir + a
	// hardcoded filename, never from user input — the gosec G304
	// "potential file inclusion" lint is a false positive here.
	f, err := os.OpenFile( //nolint:gosec // G304: launcher-controlled path, see comment above
		logPath,
		os.O_CREATE|os.O_WRONLY|os.O_APPEND,
		0o644,
	)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()

	// Best-effort writes — if the log fd has been closed
	// (extreme: disk-full mid-write), we still want to fall
	// through to showing the dialog so the user sees an error
	// message even without the log path.
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

// showStartupErrorDialog renders an osascript `display dialog` and
// returns the label of the clicked button (one of the labels in
// the buttons slice). Empty string on osascript error.
//
// Why osascript (not cgo NSAlert): pre-flight + bind-failure run
// BEFORE systray.Run starts the NSApp. NSAlert.runModal needs an
// NSApp; osascript spawns AppleScript which has its own NSApp,
// no interaction with ours. After systray.Run is up, the Quit
// confirmation modal can use cgo NSAlert instead — different code
// path, see confirm_darwin.go.
func showStartupErrorDialog(title, body string, buttons []string) string {
	if len(buttons) == 0 {
		return ""
	}
	script := fmt.Sprintf(
		`display dialog %s with title %s buttons {%s} default button %s with icon caution`,
		quoteAppleScript(body),
		quoteAppleScript(title),
		appleScriptButtonList(buttons),
		quoteAppleScript(buttons[len(buttons)-1]),
	)
	// script is built entirely from launcher-controlled constants
	// + writeStartupErrorLog details (themselves launcher-built);
	// no user input crosses this boundary. gosec G204 is a false
	// positive.
	cmd := exec.Command("osascript", "-e", script) //nolint:gosec // G204: launcher-controlled script
	out, _ := cmd.CombinedOutput()
	return parseClickedButton(string(out), buttons)
}

// showPortInUseDialog renders the port-5199-already-in-use dialog
// (Decision #28). Single button: Quit. Body explains the diagnosis
// command and (when writeStartupErrorLog succeeds) the log path
// so the user can copy + attach it to a support ticket.
func showPortInUseDialog() {
	exe, _ := os.Executable()
	logPath := writeStartupErrorLog("port-in-use", map[string]string{
		"port": healthServerPort,
		"exe":  exe,
		"os":   runtime.GOOS + "/" + runtime.GOARCH,
	})

	body := fmt.Sprintf(
		"Friday Studio cannot start.\n\n"+
			"Port %s is already in use by another application.\n\n"+
			"Run `lsof -iTCP:%s` in Terminal to see what is using it.",
		healthServerPort, healthServerPort)
	if logPath != "" {
		body += "\n\nDiagnostic log: " + logPath
	}
	_ = showStartupErrorDialog("Friday Studio", body,
		[]string{startupErrorButtonQuit})
}

// quoteAppleScript wraps a string in AppleScript double-quotes,
// escaping embedded quotes and backslashes. `display dialog` and
// `with title` arguments must be valid AppleScript expressions, so
// raw fmt %q (Go-style) doesn't suffice.
func quoteAppleScript(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\', '"':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// appleScriptButtonList renders a buttons slice as the `{"a", "b"}`
// AppleScript list syntax that `display dialog` expects.
func appleScriptButtonList(buttons []string) string {
	parts := make([]string, len(buttons))
	for i, b := range buttons {
		parts[i] = quoteAppleScript(b)
	}
	return strings.Join(parts, ", ")
}

// parseClickedButton extracts the clicked button label from
// osascript's stdout. osascript writes a line like:
//
//	button returned:Quit
//
// or just "Quit" depending on flags. We accept both. Returns "" if
// the output doesn't contain any of the known buttons (e.g.
// osascript exited with an error or the user dismissed via Esc).
func parseClickedButton(out string, buttons []string) string {
	out = strings.TrimSpace(out)
	for _, b := range buttons {
		if strings.Contains(out, b) {
			return b
		}
	}
	return ""
}
