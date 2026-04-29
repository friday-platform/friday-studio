package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// Verify the .env values the installer writes flow through to all
// supervised services. Regression guard: previously only `friday`
// got .env, so EXTERNAL_DAEMON_URL never reached `playground` and the
// browser-side window.__FRIDAY_CONFIG__ stayed empty.
func TestCommonServiceEnvFlowsToAllServices(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(envDir, ".env")
	envContent := `ANTHROPIC_API_KEY=sk-test
EXTERNAL_DAEMON_URL=http://localhost:8080
EXTERNAL_TUNNEL_URL=http://localhost:9090
FRIDAYD_URL=http://localhost:8080
LINK_DEV_MODE=true
`
	if err := os.WriteFile(envFile, []byte(envContent), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)

	specs := supervisedProcesses("/tmp/bin")
	required := []string{"friday", "link", "webhook-tunnel", "playground"}
	for _, name := range required {
		var found *processSpec
		for i := range specs {
			if specs[i].name == name {
				found = &specs[i]
				break
			}
		}
		if found == nil {
			t.Fatalf("service %q missing from supervisedProcesses", name)
		}
		joined := strings.Join(found.env, "\n")
		for _, want := range []string{"EXTERNAL_DAEMON_URL=http://localhost:8080", "EXTERNAL_TUNNEL_URL=http://localhost:9090"} {
			if !strings.Contains(joined, want) {
				t.Errorf("service %q env missing %q\ngot:\n%s", name, want, joined)
			}
		}
	}
}

// TestFridayEnv_EmitsAgentBrowserPath asserts the launcher surfaces
// FRIDAY_AGENT_BROWSER_PATH when the bundled agent-browser binary is
// present in binDir. Friday's `web` agent calls
// execFile("agent-browser", ...) at runtime; without this env-var
// emission, start.tsx can't augment PATH and the bare-name spawn
// returns ENOENT.
func TestFridayEnv_EmitsAgentBrowserPath(t *testing.T) {
	tmpBin := t.TempDir()
	binName := "agent-browser"
	if runtime.GOOS == "windows" {
		binName = "agent-browser.exe"
	}
	binPath := filepath.Join(tmpBin, binName)
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	env := fridayEnv(tmpBin)
	want := "FRIDAY_AGENT_BROWSER_PATH=" + binPath
	if !slices.Contains(env, want) {
		t.Errorf("fridayEnv missing %q. got=%v", want, env)
	}
}

// TestFridayEnv_OmitsAgentBrowserPathWhenAbsent asserts the launcher
// stays silent (no env var) when the bundled binary isn't present —
// e.g. during dev runs where the user hasn't built the runtime, or
// future variants without agent-browser shipped. start.tsx logs a
// debug line and the daemon continues; first browse call surfaces
// ENOENT with a clear error.
func TestFridayEnv_OmitsAgentBrowserPathWhenAbsent(t *testing.T) {
	emptyBin := t.TempDir()
	env := fridayEnv(emptyBin)
	for _, kv := range env {
		if strings.HasPrefix(kv, "FRIDAY_AGENT_BROWSER_PATH=") {
			t.Errorf("fridayEnv emitted %q despite missing binary", kv)
		}
	}
}

// TestCommonServiceEnv_EmitsFridayHome guards the contract that
// drives the entire ~/.friday/local redirect: every supervised
// service (friday daemon, link, webhook-tunnel, playground) must
// receive FRIDAY_HOME so getFridayHome() in @atlas/utils resolves
// to the launcher-owned home. Without this, services fall back to
// the legacy ~/.atlas location and homes silently drift apart —
// the original bug that motivated commit 41ead9310.
func TestCommonServiceEnv_EmitsFridayHome(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	env := commonServiceEnv()
	want := "FRIDAY_HOME=" + filepath.Join(tmpHome, ".friday", "local")
	if !slices.Contains(env, want) {
		t.Errorf("commonServiceEnv missing %q. got=%v", want, env)
	}

	// fridayEnv composes commonServiceEnv, so the daemon must inherit
	// FRIDAY_HOME too.
	dEnv := fridayEnv(t.TempDir())
	if !slices.Contains(dEnv, want) {
		t.Errorf("fridayEnv missing %q (via commonServiceEnv). got=%v", want, dEnv)
	}
}
