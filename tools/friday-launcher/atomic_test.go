package main

import (
	"os"
	"testing"
)

func TestLauncherState_RoundTrip(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	want := launcherState{
		AutostartInitialized: true,
		IncludeWorkspaces:    true,
	}
	if err := writeState(want); err != nil {
		t.Fatalf("writeState: %v", err)
	}

	got := readState()
	if got != want {
		t.Errorf("readState = %+v, want %+v", got, want)
	}
}

func TestLauncherState_BackwardCompat_MissingIncludeWorkspaces(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	// state.json written by an earlier launcher version that didn't know
	// about IncludeWorkspaces. Reads must succeed and default the new
	// field to false rather than erroring out.
	legacy := []byte(`{"autostart_initialized":true}`)
	if err := os.WriteFile(statePath(), legacy, 0o600); err != nil {
		t.Fatalf("seed legacy state: %v", err)
	}

	got := readState()
	if !got.AutostartInitialized {
		t.Errorf("AutostartInitialized = false, want true")
	}
	if got.IncludeWorkspaces {
		t.Errorf("IncludeWorkspaces = true, want false (default)")
	}
}
