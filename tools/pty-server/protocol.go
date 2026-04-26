package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Wire-protocol message types. The TS server (replaced by this binary)
// is the source of truth for the schema; bytes-on-the-wire must match.

type inputMsg struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

type resizeMsg struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type statusMsg struct {
	Type  string `json:"type"`
	Shell string `json:"shell"`
}

type exitMsg struct {
	Type string `json:"type"`
	Code int    `json:"code"`
}

type errorMsg struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// parseClientMessage extracts type+data from a raw client text frame.
// Malformed frames return ok=false (caller ignores them — matches TS).
type clientMsg struct {
	Type string
	Data string
	Cols int
	Rows int
}

func parseClientMessage(raw []byte) (clientMsg, bool) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return clientMsg{}, false
	}
	switch probe.Type {
	case "input":
		var m inputMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			return clientMsg{}, false
		}
		return clientMsg{Type: "input", Data: m.Data}, true
	case "resize":
		var m resizeMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			return clientMsg{}, false
		}
		return clientMsg{Type: "resize", Cols: m.Cols, Rows: m.Rows}, true
	default:
		return clientMsg{}, false
	}
}

// validateCwd resolves the requested cwd, defending gosec G304 by stat'ing
// the path before passing it to PTY spawn. Empty input falls back to
// PTY_CWD env or os.Getwd().
func validateCwd(raw, fallback string) (string, error) {
	if raw == "" {
		if fallback != "" {
			return validateCwd(fallback, "")
		}
		return os.Getwd()
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("invalid cwd: %w", err)
	}
	info, err := os.Stat(abs) //nolint:gosec // G703: path is validated here (this is the validator).
	if err != nil {
		return "", fmt.Errorf("cwd does not exist: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("cwd is not a directory")
	}
	return abs, nil
}
