package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Pre-flight binary check (Decision #12 + #21).
//
// Runs BEFORE supervisor start in the normal-startup path. If any
// supervised binary is missing from binDir, we cannot make forward
// progress — process-compose would spawn the placeholder, fail, and
// the launcher would emit "starting → failed" to the wizard with no
// human-readable explanation.
//
// Pre-flight short-circuits that: it checks every binary up front,
// renders a missing-binaries dialog (osascript on macOS,
// MessageBoxW on Windows, stderr-only on Linux), writes a diagnostic
// log to ~/.friday/local/logs/launcher-startup.log (Decision #34),
// and exits 1.
//
// The exception is `--uninstall` and `--autostart` modes, which
// don't need any supervised binaries — those paths skip pre-flight.

// requiredBinaries returns the names of the supervised binaries
// pre-flight must verify. Wraps the canonical list in `project.go`.
func requiredBinaries() []string {
	return supervisedProcessNames()
}

// checkBinariesPresent verifies that every supervised binary exists
// at `binDir/<name>` as a non-empty regular file. Returns the list
// of missing binaries (empty slice on success) plus the first
// stat-error if any — non-existence is an empty error; permission /
// IO errors surface so the user sees something more actionable than
// "missing binary".
//
// We do NOT verify the binaries are valid Mach-O / PE / ELF or
// carry the executable bit — that's process-compose's job at spawn
// time, not pre-flight's. The check is deliberately presence + type
// + non-zero size: the 2026-04-27 v0.0.8 incident produced 0-byte
// stubs that passed `os.Stat` but failed `Exec`; pre-flight catches
// exactly that class.
func checkBinariesPresent(binDir string) (missing []string, err error) {
	if binDir == "" {
		return nil, errors.New("binDir is empty")
	}
	for _, name := range requiredBinaries() {
		path := filepath.Join(binDir, name)
		info, statErr := os.Stat(path)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				missing = append(missing, name)
				continue
			}
			// Permission / IO error — surface as the function's
			// error so the dialog can carry the OS message rather
			// than just "missing".
			return nil, fmt.Errorf("stat %s: %w", path, statErr)
		}
		// Reject directories and zero-size placeholders. A 0-byte
		// "binary" got us into the 2026-04-27 v0.0.8 incident — the
		// install dropped a stub that passed os.Stat but failed
		// Exec with EOFonExec.
		if info.IsDir() {
			missing = append(missing, name)
			continue
		}
		if info.Size() == 0 {
			missing = append(missing, name)
			continue
		}
	}
	return missing, nil
}

// runPreflight is the launcher's entry-point hook for the binaries
// check. Called from main() AFTER `--uninstall` / `--autostart`
// dispatch (those paths don't need binaries) but BEFORE
// `systray.Run`. On failure: writes ONE diagnostic log entry,
// passes its path to the missing-binaries dialog so the dialog
// body can surface it, exits 1.
//
// Splitting the dialog/exit from the check itself (`checkBinariesPresent`)
// keeps the check unit-testable without spawning real dialogs.
func runPreflight(binDir string) {
	missing, err := checkBinariesPresent(binDir)
	if err != nil {
		details := map[string]string{
			"bin_dir": binDir,
			"error":   err.Error(),
		}
		logPath := writeStartupErrorLog("preflight-stat-error", details)
		showMissingBinariesDialog(binDir, []string{}, err.Error(), logPath)
		os.Exit(1)
	}
	if len(missing) == 0 {
		return
	}
	// Some binaries missing. Build details for the diagnostic log
	// (one key per missing binary so support can copy/paste lines)
	// then show the dialog.
	details := map[string]string{
		"bin_dir": binDir,
		"missing": strings.Join(missing, ", "),
	}
	logPath := writeStartupErrorLog("preflight-missing-binaries", details)
	showMissingBinariesDialog(binDir, missing, "", logPath)
	os.Exit(1)
}
