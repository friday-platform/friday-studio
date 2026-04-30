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

// TestImportDotEnvIntoProcessEnv_PopulatesPortOverrides closes the
// gap that made FRIDAY_PORT_PLAYGROUND=15200 in ~/.friday/local/.env
// silently ignored: portOverride() reads via os.Getenv, but pre-fix
// the .env values flowed only into spawned-service envs (via
// commonServiceEnv) — never into the launcher's own process env.
// importDotEnvIntoProcessEnv() bridges that gap; this test pins the
// behavior so a future refactor can't regress it.
func TestImportDotEnvIntoProcessEnv_PopulatesPortOverrides(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(envDir, ".env")
	envContent := "FRIDAY_PORT_PLAYGROUND=15200\nLINK_DEV_MODE=true\n"
	if err := os.WriteFile(envFile, []byte(envContent), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)
	// Make sure the test starts from a clean slate for the keys we
	// expect importDotEnvIntoProcessEnv to populate.
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "")
	os.Unsetenv("FRIDAY_PORT_PLAYGROUND")

	importDotEnvIntoProcessEnv()

	if got := os.Getenv("FRIDAY_PORT_PLAYGROUND"); got != "15200" {
		t.Errorf("FRIDAY_PORT_PLAYGROUND after import = %q, want 15200", got)
	}
	// portOverride consults os.Getenv with the same translation rule the
	// public contract documents (uppercase, hyphens → underscores).
	if got := portOverride("playground"); got != "15200" {
		t.Errorf("portOverride(playground) after import = %q, want 15200", got)
	}
}

// TestImportDotEnvIntoProcessEnv_PreservesExistingEnv asserts that an
// already-set value (e.g. shell export) wins over the .env file. This
// matches deno's --env-file precedence rule: process env > file. A
// regression that flipped the precedence would silently override the
// user's deliberate shell-level overrides on every restart.
func TestImportDotEnvIntoProcessEnv_PreservesExistingEnv(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(envDir, ".env")
	if err := os.WriteFile(envFile, []byte("FRIDAY_PORT_FRIDAY=18080\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)
	t.Setenv("FRIDAY_PORT_FRIDAY", "29999") // shell-level value

	importDotEnvIntoProcessEnv()

	if got := os.Getenv("FRIDAY_PORT_FRIDAY"); got != "29999" {
		t.Errorf("shell value clobbered: FRIDAY_PORT_FRIDAY = %q, want 29999", got)
	}
}

// TestSupervisedProcesses_PortOverridesPropagate verifies that
// FRIDAY_PORT_<name> env vars don't just update the launcher's own
// readiness probe (which the original portOverride code already did)
// but also propagate the port into the supervised binary itself —
// either as a CLI flag (friday's --port) or an env var (LINK_PORT,
// TUNNEL_PORT, PLAYGROUND_PORT). Without this propagation the launcher
// would probe the override port while the binary stays on its hardcoded
// default, and the supervisor stays "starting" forever.
func TestSupervisedProcesses_PortOverridesPropagate(t *testing.T) {
	t.Setenv("FRIDAY_PORT_FRIDAY", "18080")
	t.Setenv("FRIDAY_PORT_LINK", "13100")
	t.Setenv("FRIDAY_PORT_WEBHOOK_TUNNEL", "19090")
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")

	specs := supervisedProcesses("/tmp/bin")

	cases := []struct {
		name string
		// One of args / env must contain the wantSubstring.
		check    string
		wantArg  string // exact-arg expectation: presence of the literal token in args
		wantEnv  string // KEY=VAL expectation: presence in env
		wantPort string // healthPort
	}{
		{name: "friday", check: "args", wantArg: "--port", wantPort: "18080"},
		{name: "link", check: "env", wantEnv: "LINK_PORT=13100", wantPort: "13100"},
		{name: "webhook-tunnel", check: "env", wantEnv: "TUNNEL_PORT=19090", wantPort: "19090"},
		{name: "playground", check: "env", wantEnv: "PLAYGROUND_PORT=15200", wantPort: "15200"},
	}

	for _, tc := range cases {
		var found *processSpec
		for i := range specs {
			if specs[i].name == tc.name {
				found = &specs[i]
				break
			}
		}
		if found == nil {
			t.Fatalf("service %q missing from supervisedProcesses", tc.name)
		}

		if found.healthPort != tc.wantPort {
			t.Errorf("service %q: healthPort = %q, want %q",
				tc.name, found.healthPort, tc.wantPort)
		}

		switch tc.check {
		case "args":
			// For friday, both the flag and the value must appear, and
			// the value must immediately follow the flag.
			joined := strings.Join(found.args, " ")
			want := tc.wantArg + " " + tc.wantPort
			if !strings.Contains(joined, want) {
				t.Errorf("service %q: args missing %q\ngot: %s",
					tc.name, want, joined)
			}
		case "env":
			if !slices.Contains(found.env, tc.wantEnv) {
				t.Errorf("service %q: env missing %q\ngot:\n%s",
					tc.name, tc.wantEnv, strings.Join(found.env, "\n"))
			}
		}
	}
}

// TestPlaygroundURL_HonorsPortOverride asserts the tray opens the
// correct URL when the playground port is overridden. Without this
// the tray click after a port override silently lands on
// http://localhost:5200 (default) and the user sees connection
// refused.
func TestPlaygroundURL_HonorsPortOverride(t *testing.T) {
	if got := playgroundURL(); got != "http://localhost:5200" {
		t.Errorf("default playgroundURL = %q, want http://localhost:5200", got)
	}
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	if got := playgroundURL(); got != "http://localhost:15200" {
		t.Errorf("overridden playgroundURL = %q, want http://localhost:15200", got)
	}
}

// TestCommonServiceEnv_EmitsFridayHome guards the contract that
// drives the entire ~/.friday/local redirect: every supervised
// service (friday daemon, link, webhook-tunnel, playground) must
// receive FRIDAY_HOME so getFridayHome() in @atlas/utils resolves
// to the launcher-owned home. Without this, services fall back to
// the legacy ~/.atlas location and homes silently drift apart —
// the original bug that motivated commit 41ead9310.
//
// Walks supervisedProcesses() rather than spot-checking the factory
// helper, so a refactor that swaps any one service's `env:
// commonServiceEnv()` to a custom slice surfaces immediately.
func TestCommonServiceEnv_EmitsFridayHome(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	want := "FRIDAY_HOME=" + filepath.Join(tmpHome, ".friday", "local")

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
		if !slices.Contains(found.env, want) {
			t.Errorf("service %q env missing %q\ngot:\n%s",
				name, want, strings.Join(found.env, "\n"))
		}
	}
}

// TestCommonServiceEnv_EmitsFridayConfigPath guards the wizard ↔
// daemon contract for friday.yml lookup. atlas-daemon.ts reads
// `FRIDAY_CONFIG_PATH ?? process.cwd()` to find friday.yml. Under the
// launcher, cwd is whatever process-compose inherits (typically `/`
// on macOS), so without an explicit pin the daemon would never find
// the wizard's friday.yml at ~/.friday/local/friday.yml. This test
// asserts every supervised service receives the pinned value;
// per-service propagation matters because a future refactor that
// swaps one service's `env: commonServiceEnv()` to a custom slice
// would silently drop the var for that service.
func TestCommonServiceEnv_EmitsFridayConfigPath(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	want := "FRIDAY_CONFIG_PATH=" + filepath.Join(tmpHome, ".friday", "local")

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
		if !slices.Contains(found.env, want) {
			t.Errorf("service %q env missing %q\ngot:\n%s",
				name, want, strings.Join(found.env, "\n"))
		}
	}
}
