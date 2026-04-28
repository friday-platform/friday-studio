//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// startupErrorButtonQuit is the label osascript uses both to render
// and to identify which button the user clicked. Match exactly with
// parseClickedButton's lookup. Stack 3 adds the missing-binaries
// variant which introduces a second "Open download page" button.
const startupErrorButtonQuit = "Quit"

// writeStartupErrorLog + startupErrorLogPath live in preflight_log.go
// (shared across platforms — the log file format and fallback rules
// are identical; only the dialog renderer differs per OS).

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
