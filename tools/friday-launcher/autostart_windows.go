//go:build windows

package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runValueName = "FridayStudio"

func enableAutostart() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	// WRITE|READ so the same handle could be reused; we still open a
	// separate READ-only handle in isAutostartEnabled() to follow
	// principle of least privilege per call site.
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey,
		registry.WRITE|registry.READ)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(runValueName,
		fmt.Sprintf(`"%s" --no-browser`, exe))
}

func disableAutostart() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey,
		registry.WRITE)
	if err != nil {
		// Key absent is OK.
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(runValueName); err != nil &&
		err != registry.ErrNotExist {
		return err
	}
	return nil
}

func isAutostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey,
		registry.READ)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runValueName)
	return err == nil
}

// currentAutostartPath reads the registered command and extracts the
// executable path (stripping the surrounding quotes and the
// --no-browser tail). Returns "" if not registered or malformed.
func currentAutostartPath() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey,
		registry.READ)
	if err != nil {
		return ""
	}
	defer k.Close()
	val, _, err := k.GetStringValue(runValueName)
	if err != nil {
		return ""
	}
	// Stored as: "C:\path\to\exe.exe" --no-browser
	// We want: C:\path\to\exe.exe
	if len(val) < 2 || val[0] != '"' {
		return ""
	}
	endQuote := -1
	for i := 1; i < len(val); i++ {
		if val[i] == '"' {
			endQuote = i
			break
		}
	}
	if endQuote == -1 {
		return ""
	}
	return val[1:endQuote]
}
