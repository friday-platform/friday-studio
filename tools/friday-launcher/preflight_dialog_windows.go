//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// Windows-side parity for preflight_dialog_darwin.go. Same Go API
// surface (`showPortInUseDialog`) so main.go dispatches uniformly
// per GOOS. Stack 3 will extend with the missing-binaries variant.
// writeStartupErrorLog + startupErrorLogPath live in preflight_log.go
// (shared across platforms — log file format is identical).

// downloadsPageURL is where users land when they hit "Open downloads
// page" on the missing-binaries dialog. Same value as darwin.
const downloadsPageURL = "https://download.fridayplatform.io/studio/"

// showMissingBinariesDialog is the Windows parity for the darwin
// variant. Windows MessageBoxW only supports a fixed set of button
// combos (MB_OK, MB_OKCANCEL, MB_YESNO, etc.) — none of which fit
// "Quit | Open downloads page". We use MB_YESNO with text body
// asking "Open downloads page?"; YES → open, NO → quit. Less
// elegant than the macOS variant but native and dependency-free.
func showMissingBinariesDialog(binDir string, missing []string, errMsg, logPath string) {
	var body string
	if errMsg != "" {
		body = fmt.Sprintf(
			"Friday Studio cannot start.\r\n\r\n"+
				"Could not read the binaries directory:\r\n%s\r\n\r\n"+
				"%s\r\n\r\n"+
				"Reinstalling Friday Studio usually fixes this.",
			binDir, errMsg)
	} else {
		body = fmt.Sprintf(
			"Friday Studio cannot start.\r\n\r\n"+
				"The following binaries are missing from\r\n%s:\r\n  • %s\r\n\r\n"+
				"Reinstalling Friday Studio will restore them.",
			binDir, strings.Join(missing, "\r\n  • "))
	}
	if logPath != "" {
		body += "\r\n\r\nDiagnostic log: " + logPath
	}
	body += "\r\n\r\nOpen the downloads page now?"

	if messageBoxYesNo("Friday Studio", body) {
		// `cmd /C start <url>` is the Windows native URL dispatcher;
		// no dependency on a browser being installed at a known
		// path. gosec G204 false positive: launcher-controlled URL.
		_ = exec.Command("cmd", "/C", "start", downloadsPageURL).Run() //nolint:gosec // G204: launcher-controlled URL
	}
}

// messageBoxYesNo wraps user32!MessageBoxW with MB_YESNO buttons.
// Returns true iff the user clicked Yes (IDYES = 6).
func messageBoxYesNo(title, body string) bool {
	const (
		MB_YESNO    = 0x00000004
		MB_ICONSTOP = 0x00000010
		MB_TOPMOST  = 0x00040000
		IDYES       = 6
	)
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	bodyPtr, _ := syscall.UTF16PtrFromString(body)
	ret, _, _ := proc.Call(
		uintptr(0),
		uintptr(unsafe.Pointer(bodyPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		uintptr(MB_YESNO|MB_ICONSTOP|MB_TOPMOST),
	)
	return int(ret) == IDYES
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
