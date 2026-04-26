//go:build windows

package main

import (
	"os"
	"os/exec"
)

// defaultShell picks the shell to spawn on Windows.
// Priority chain (Q1 resolution): user override → COMSPEC env →
// pwsh.exe (modern PowerShell) → powershell.exe (legacy) → cmd.exe.
// COMSPEC is the canonical Microsoft env var pointing to the command
// processor; honoring it first preserves user customization.
func defaultShell(configured string) (string, []string) {
	if configured != "" {
		return configured, nil
	}
	if v := os.Getenv("COMSPEC"); v != "" {
		return v, nil
	}
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("powershell.exe"); err == nil {
		return p, nil
	}
	return "cmd.exe", nil
}
