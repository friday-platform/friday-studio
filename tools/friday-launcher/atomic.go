package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// atomicWriteFile writes data to path via a temp file in the same
// directory and renames it into place. POSIX rename is atomic; on
// modern Windows NTFS, os.Rename calls MoveFileEx with
// MOVEFILE_REPLACE_EXISTING which is also atomic. Used for state.json,
// the LaunchAgent plist, and any other file where a partial write
// after a crash would break next-startup behavior.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

type launcherState struct {
	AutostartInitialized bool `json:"autostart_initialized"`
}

func readState() launcherState {
	data, err := os.ReadFile(statePath())
	if err != nil {
		return launcherState{}
	}
	var s launcherState
	if err := json.Unmarshal(data, &s); err != nil {
		return launcherState{}
	}
	return s
}

func writeState(s launcherState) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(statePath(), data, 0o600)
}
