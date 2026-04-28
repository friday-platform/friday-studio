//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// confirmQuit shows the Windows Quit-confirmation MessageBoxW with
// MB_OKCANCEL + MB_ICONQUESTION and returns true iff the user
// clicked OK. Synchronous: blocks the click-handler thread until
// the user dismisses the dialog. MessageBoxW is thread-safe — no
// special main-thread requirement on Windows.
//
// Mirrors confirm_darwin.go's behavior for Decision #2 / #13:
// explicit confirmation in front of "shut down all services".
func confirmQuit() bool {
	const (
		mbOkCancel     = 0x00000001
		mbIconQuestion = 0x00000020
		mbDefButton1   = 0x00000000 // OK is default — same as darwin
		mbTopmost      = 0x00040000

		idOK = 1
	)
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	titlePtr, _ := syscall.UTF16PtrFromString("Quit Friday Studio?")
	bodyPtr, _ := syscall.UTF16PtrFromString(
		"Friday Studio will stop all running services and shut down. " +
			"This may take up to 30 seconds.")
	ret, _, _ := proc.Call(
		uintptr(0),
		uintptr(unsafe.Pointer(bodyPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		uintptr(mbOkCancel|mbIconQuestion|mbDefButton1|mbTopmost),
	)
	return ret == idOK
}
