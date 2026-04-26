//go:build windows

package main

import "golang.org/x/sys/windows"

// killProcess terminates pid via TerminateProcess. Best-effort.
func killProcess(pid int) {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	_ = windows.TerminateProcess(h, 1)
}
