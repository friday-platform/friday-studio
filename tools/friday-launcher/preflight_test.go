package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCheckBinariesPresent_AllPresent: every required binary
// exists, has size > 0 — empty missing slice + nil error.
func TestCheckBinariesPresent_AllPresent(t *testing.T) {
	binDir := t.TempDir()
	for _, name := range requiredBinaries() {
		path := filepath.Join(binDir, name)
		// 4-byte stub is enough to satisfy the size>0 check.
		if err := os.WriteFile(path, []byte("stub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	missing, err := checkBinariesPresent(binDir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(missing) != 0 {
		t.Errorf("missing = %v, want empty", missing)
	}
}

// TestCheckBinariesPresent_OneMissing: only some binaries exist;
// the missing slice lists exactly the absent names.
func TestCheckBinariesPresent_OneMissing(t *testing.T) {
	binDir := t.TempDir()
	all := requiredBinaries()
	if len(all) < 2 {
		t.Skip("need at least 2 supervised processes for this case")
	}
	// Create all but the last.
	for _, name := range all[:len(all)-1] {
		path := filepath.Join(binDir, name)
		if err := os.WriteFile(path, []byte("stub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	missing, err := checkBinariesPresent(binDir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(missing) != 1 || missing[0] != all[len(all)-1] {
		t.Errorf("missing = %v, want [%s]", missing, all[len(all)-1])
	}
}

// TestCheckBinariesPresent_ZeroSizePlaceholderCountsAsMissing:
// 0-byte files count as missing. The 2026-04-27 v0.0.8 incident
// involved an installer that wrote 0-byte stubs that passed the
// "file exists" check but failed exec; pre-flight must catch this.
func TestCheckBinariesPresent_ZeroSizePlaceholderCountsAsMissing(t *testing.T) {
	binDir := t.TempDir()
	all := requiredBinaries()
	// Plant a real binary for everyone except `friday`, which
	// gets a zero-byte placeholder.
	for _, name := range all {
		path := filepath.Join(binDir, name)
		var content []byte
		if name != "friday" {
			content = []byte("stub")
		}
		if err := os.WriteFile(path, content, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	missing, err := checkBinariesPresent(binDir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(missing) != 1 || missing[0] != "friday" {
		t.Errorf("missing = %v, want [friday]", missing)
	}
}

// TestCheckBinariesPresent_DirectoryCountsAsMissing: a directory
// with the right NAME at binDir/<bin> is NOT a binary; treat as
// missing. Catches the "user accidentally extracted nested folders"
// failure mode.
func TestCheckBinariesPresent_DirectoryCountsAsMissing(t *testing.T) {
	binDir := t.TempDir()
	all := requiredBinaries()
	for _, name := range all {
		path := filepath.Join(binDir, name)
		if name == "friday" {
			if err := os.MkdirAll(path, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(path, []byte("stub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	missing, err := checkBinariesPresent(binDir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(missing) != 1 || missing[0] != "friday" {
		t.Errorf("missing = %v, want [friday]", missing)
	}
}

// TestCheckBinariesPresent_EmptyBinDir: empty string fails fast
// — pre-flight must distinguish "nothing to check" from
// "everything present"; an unconfigured launcher should NOT silently
// pass pre-flight.
func TestCheckBinariesPresent_EmptyBinDir(t *testing.T) {
	missing, err := checkBinariesPresent("")
	if err == nil {
		t.Errorf("err = nil, want non-nil for empty binDir")
	}
	if missing != nil {
		t.Errorf("missing = %v, want nil", missing)
	}
}

// TestCheckBinariesPresent_NonExistentBinDir: a binDir that doesn't
// exist returns ALL required binaries as missing (each Stat returns
// ENOENT). Catches "user passed wrong --bin-dir" cleanly.
func TestCheckBinariesPresent_NonExistentBinDir(t *testing.T) {
	binDir := filepath.Join(t.TempDir(), "does-not-exist")
	missing, err := checkBinariesPresent(binDir)
	if err != nil {
		t.Fatalf("err = %v, want nil (non-existence is missing, not error)", err)
	}
	want := requiredBinaries()
	if len(missing) != len(want) {
		t.Errorf("missing count = %d, want %d (got=%v)", len(missing), len(want), missing)
	}
}

// TestRequiredBinariesCountMatchesPlan: documents the cardinality
// invariant — 6 supervised binaries, matching CLAUDE.md and the
// wizard's checklist UI. Pinning here means a refactor that
// silently drops one would fail this test in addition to
// TestSupervisedProcessesPinSet.
func TestRequiredBinariesCountMatchesPlan(t *testing.T) {
	if got := len(requiredBinaries()); got != 6 {
		t.Errorf("requiredBinaries() count = %d, want 6 (CLAUDE.md)", got)
	}
}
