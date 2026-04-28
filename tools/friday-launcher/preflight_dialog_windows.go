//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

// Windows-side parity for preflight_dialog_darwin.go. Same Go API
// surface (`writeStartupErrorLog`, `showPortInUseDialog`) so main.go
// dispatches uniformly per GOOS. Stack 3 will extend with the
// missing-binaries variant.

const startupErrorLogFallback = "friday-launcher-startup.log"

// writeStartupErrorLog mirrors the darwin implementation: primary
// path %USERPROFILE%\.friday\local\logs\launcher-startup.log,
// fallback os.TempDir()\friday-launcher-startup.log.
func writeStartupErrorLog(reason string, details map[string]string) string {
	logPath := startupErrorLogPath()
	if logPath == "" {
		return ""
	}
	f, err := os.OpenFile( //nolint:gosec // G304: launcher-controlled path
		logPath,
		os.O_CREATE|os.O_WRONLY|os.O_APPEND,
		0o644,
	)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()

	_, _ = fmt.Fprintf(f, "%s startup error: %s\n",
		time.Now().UTC().Format(time.RFC3339), reason)
	for k, v := range details {
		_, _ = fmt.Fprintf(f, "  %s: %s\n", k, v)
	}
	_, _ = fmt.Fprintln(f, "")
	return logPath
}

func startupErrorLogPath() string {
	home, err := os.UserHomeDir()
	if err == nil {
		dir := filepath.Join(home, ".friday", "local", "logs")
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

// showPortInUseDialog renders a Windows MessageBoxW with the same
// content + log path as the darwin variant. MB_ICONSTOP (red x)
// because the launcher is about to exit.
func showPortInUseDialog() {
	exe, _ := os.Executable()
	logPath := writeStartupErrorLog("port-in-use", map[string]string{
		"port": healthServerPort,
		"exe":  exe,
		"os":   runtime.GOOS + "/" + runtime.GOARCH,
	})

	body := fmt.Sprintf(
		"Friday Studio cannot start.\r\n\r\n"+
			"Port %s is already in use by another application.\r\n\r\n"+
			"Run `netstat -ano | findstr :%s` in Command Prompt to see what is using it.",
		healthServerPort, healthServerPort)
	if logPath != "" {
		body += "\r\n\r\nDiagnostic log: " + logPath
	}
	messageBox("Friday Studio", body)
}

// messageBox is a thin wrapper around user32!MessageBoxW so we
// don't pull in a full GUI dep just to show a single dialog at
// startup. MB_OK | MB_ICONSTOP | MB_TOPMOST.
func messageBox(title, body string) {
	const (
		MB_OK       = 0x00000000
		MB_ICONSTOP = 0x00000010
		MB_TOPMOST  = 0x00040000
	)
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	bodyPtr, _ := syscall.UTF16PtrFromString(body)
	_, _, _ = proc.Call(
		uintptr(0),
		uintptr(unsafe.Pointer(bodyPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		uintptr(MB_OK|MB_ICONSTOP|MB_TOPMOST),
	)
}
