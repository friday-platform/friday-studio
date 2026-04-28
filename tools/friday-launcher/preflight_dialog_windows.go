//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// Windows-side parity for preflight_dialog_darwin.go. Same Go API
// surface (`showPortInUseDialog`) so main.go dispatches uniformly
// per GOOS. Stack 3 will extend with the missing-binaries variant.
// writeStartupErrorLog + startupErrorLogPath live in preflight_log.go
// (shared across platforms — log file format is identical).

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
