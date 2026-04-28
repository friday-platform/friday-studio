package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withHomeDir overrides HOME for the duration of the test so
// writeStartupErrorLog writes into a tempdir we can inspect. macOS
// honors HOME via os.UserHomeDir(); same on Linux. (Windows uses
// USERPROFILE — different env var — so this test is darwin/linux.)
func withHomeDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	return dir
}

// TestWriteStartupErrorLog_PrimaryPath asserts the log file lands
// at ~/.friday/local/logs/launcher-startup.log on a freshly-set HOME
// (mkdir succeeds), AND the returned path matches.
func TestWriteStartupErrorLog_PrimaryPath(t *testing.T) {
	home := withHomeDir(t)
	logPath := writeStartupErrorLog("test", map[string]string{
		"k": "v",
	})

	want := filepath.Join(home, ".friday", "local", "logs", "launcher-startup.log")
	if logPath != want {
		t.Errorf("returned path = %q, want %q", logPath, want)
	}

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "startup error: test") {
		t.Errorf("log missing reason line: %q", got)
	}
	if !strings.Contains(got, "k: v") {
		t.Errorf("log missing detail line: %q", got)
	}
}

// TestWriteStartupErrorLog_AppendMode confirms two consecutive
// invocations produce a file with both entries (append mode set on
// O_APPEND). The wizard relies on this so a user with multiple
// failed startups can attach the full history.
func TestWriteStartupErrorLog_AppendMode(t *testing.T) {
	withHomeDir(t)
	first := writeStartupErrorLog("first", map[string]string{"i": "1"})
	second := writeStartupErrorLog("second", map[string]string{"i": "2"})
	if first != second {
		t.Errorf("paths differ: %q vs %q", first, second)
	}
	data, err := os.ReadFile(first)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "startup error: first") {
		t.Errorf("first entry missing: %q", got)
	}
	if !strings.Contains(got, "startup error: second") {
		t.Errorf("second entry missing: %q", got)
	}
}

// TestWriteStartupErrorLog_FallbackToTempDir simulates the
// "primary path mkdir fails" case by setting HOME to a path that
// can't be created (we use a regular file masquerading as the
// HOME root so MkdirAll bombs). The log should land in os.TempDir
// instead, with the returned path matching.
func TestWriteStartupErrorLog_FallbackToTempDir(t *testing.T) {
	// Construct an unwritable HOME by pointing at a regular file
	// with a non-traversable parent. Simpler: point HOME at a
	// path under an existing FILE — MkdirAll on a path that
	// crosses through a file fails with ENOTDIR.
	parent := t.TempDir()
	blocker := filepath.Join(parent, "blocker")
	if err := os.WriteFile(blocker, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", blocker)

	logPath := writeStartupErrorLog("fallback", map[string]string{"k": "v"})
	if logPath == "" {
		t.Fatal("expected fallback path, got empty string")
	}
	if !strings.Contains(logPath, startupErrorLogFallback) {
		t.Errorf("fallback path = %q, want suffix %q",
			logPath, startupErrorLogFallback)
	}
	if !strings.HasPrefix(logPath, os.TempDir()) {
		t.Errorf("fallback path = %q, want prefix %q",
			logPath, os.TempDir())
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Errorf("fallback file not written: %v", err)
	}
}
