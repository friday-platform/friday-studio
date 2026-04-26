//go:build !windows

package main

import (
	"os"
	"strings"
)

// defaultShell returns the shell to spawn and the args it requires.
// Mirrors server.ts:84-89: zsh gets `-f` (skip rcs); bash gets
// `--norc --noprofile`; everything else gets no extra args.
func defaultShell(configured string) (string, []string) {
	shell := configured
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/bash"
	}
	switch {
	case strings.HasSuffix(shell, "/zsh"):
		return shell, []string{"-f"}
	case strings.HasSuffix(shell, "/bash"):
		return shell, []string{"--norc", "--noprofile"}
	default:
		return shell, nil
	}
}
