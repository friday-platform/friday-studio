package main

import (
	"os"
	"testing"
)

func TestLauncherState_RoundTrip(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	want := launcherState{
		AutostartInitialized: true,
	}
	if err := writeState(want); err != nil {
		t.Fatalf("writeState: %v", err)
	}

	got := readState()
	if got != want {
		t.Errorf("readState = %+v, want %+v", got, want)
	}
}

func TestLauncherState_IgnoresLegacyIncludeWorkspaces(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	// state.json written by the interim checkbox version that persisted
	// an include_workspaces field. After the submenu redesign that field
	// is gone; reads must still succeed (the unknown key is ignored) and
	// preserve AutostartInitialized rather than erroring out.
	legacy := []byte(`{"autostart_initialized":true,"include_workspaces":true}`)
	if err := os.WriteFile(statePath(), legacy, 0o600); err != nil {
		t.Fatalf("seed legacy state: %v", err)
	}

	got := readState()
	if !got.AutostartInitialized {
		t.Errorf("AutostartInitialized = false, want true")
	}
}
