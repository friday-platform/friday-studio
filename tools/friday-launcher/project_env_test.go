package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
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

// TestFridayEnv_EmitsAgentSDKVersion asserts the launcher pins the
// friday-agent-sdk PyPI version in the daemon's env. Coordinated with
// apps/atlasd/src/agent-spawn.ts — the daemon spawns user agents via
// `uv run --with friday-agent-sdk==<this>` when both this var and
// FRIDAY_UV_PATH are set. Bumping is a deliberate launcher-release
// step; this test pins that the value flows through.
func TestFridayEnv_EmitsAgentSDKVersion(t *testing.T) {
	env := fridayEnv(t.TempDir())
	want := "FRIDAY_AGENT_SDK_VERSION=" + bundledAgentSDKVersion
	if !slices.Contains(env, want) {
		t.Errorf("fridayEnv missing %q. got=%v", want, env)
	}
}

// TestFridayEnv_PinsUvCachesUnderFridayHome asserts uv's managed Python
// interpreter dir and wheel cache are scoped to <friday-home>/uv/
// rather than uv's XDG default (~/.local/share/uv, ~/.cache/uv). Keeps
// everything Friday provisions inside the user's Friday data dir.
func TestFridayEnv_PinsUvCachesUnderFridayHome(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", filepath.Join(tmpHome, ".friday", "local"))

	env := fridayEnv(t.TempDir())
	wantPython := "UV_PYTHON_INSTALL_DIR=" + filepath.Join(tmpHome, ".friday", "local", "uv", "python")
	wantCache := "UV_CACHE_DIR=" + filepath.Join(tmpHome, ".friday", "local", "uv", "cache")

	if !slices.Contains(env, wantPython) {
		t.Errorf("fridayEnv missing %q. got=%v", wantPython, env)
	}
	if !slices.Contains(env, wantCache) {
		t.Errorf("fridayEnv missing %q. got=%v", wantCache, env)
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
	_ = os.Unsetenv("FRIDAY_PORT_PLAYGROUND")

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

// TestImportDotEnvIntoProcessEnv_StripsSurroundingQuotes asserts that
// values written with surrounding quotes by atlasd's pre-fix
// stringify (or by hand-edited .env files using standard dotenv
// quoting) reach spawned services unquoted. Regression guard: prior
// to the fix, an API key like sk-ant-foo persisted via the Settings
// UI ended up on disk as `'sk-ant-foo'`, which the launcher forwarded
// verbatim to agents, so authentication failed with a literal-quoted
// key.
func TestImportDotEnvIntoProcessEnv_StripsSurroundingQuotes(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(envDir, ".env")
	envContent := "ANTHROPIC_API_KEY='sk-ant-quoted-single'\nOPENAI_API_KEY=\"sk-proj-quoted-double\"\nMIXED_QUOTE='leftover\"\nPLAIN_KEY=sk-no-quotes\n"
	if err := os.WriteFile(envFile, []byte(envContent), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)
	// importDotEnvIntoProcessEnv calls os.Setenv directly with no restore,
	// and t.Setenv("", "") won't work here because the import skips keys
	// already set (LookupEnv returns true for empty strings). Capture the
	// prior value and restore it via t.Cleanup so these keys don't leak
	// into sibling tests.
	for _, k := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MIXED_QUOTE", "PLAIN_KEY"} {
		prev, hadPrev := os.LookupEnv(k)
		t.Cleanup(func() {
			if hadPrev {
				_ = os.Setenv(k, prev)
			} else {
				_ = os.Unsetenv(k)
			}
		})
		_ = os.Unsetenv(k)
	}

	importDotEnvIntoProcessEnv()

	cases := map[string]string{
		"ANTHROPIC_API_KEY": "sk-ant-quoted-single",
		"OPENAI_API_KEY":    "sk-proj-quoted-double",
		"MIXED_QUOTE":       "'leftover\"", // mismatched quotes left as-is
		"PLAIN_KEY":         "sk-no-quotes",
	}
	for k, want := range cases {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
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
//
// Uses a tempdir as FRIDAY_LAUNCHER_HOME so the test doesn't depend
// on whether the real ~/.friday/local/tls/browser.crt happens to be
// on the developer's machine — keeps the assertion deterministic.
func TestPlaygroundURL_HonorsPortOverride(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if got := playgroundURL(); got != "http://localhost:5200" {
		t.Errorf("default playgroundURL = %q, want http://localhost:5200", got)
	}
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	if got := playgroundURL(); got != "http://localhost:15200" {
		t.Errorf("overridden playgroundURL = %q, want http://localhost:15200", got)
	}
}

// TestPlaygroundURL_UsesHttpsWhenCertPresent asserts that once the
// installer has dropped the browser-trusted cert pair into
// <friendlyHome()>/tls/, the launcher opens the https origin matching
// the cert SAN — not http://localhost, which would land on the same
// port but show a cert-name-mismatch warning (browser → 127.0.0.1 vs
// cert CN local.hellofriday.ai).
func TestPlaygroundURL_UsesHttpsWhenCertPresent(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	tlsDir := filepath.Join(tmp, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatalf("mkdir tls: %v", err)
	}
	// Real PEM matters now that playgroundURL/hasValidBrowserCert parses
	// the file and checks notBefore/notAfter — a stub body would round-
	// trip as "invalid cert" and the URL would stay on http.
	half := 12 * time.Hour
	certPEM, _ := makeTestCert(t, 24*time.Hour, &half)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), certPEM, 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.key"), []byte("key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	if got := playgroundURL(); got != "https://local.hellofriday.ai:5200" {
		t.Errorf("playgroundURL with cert = %q, want https://local.hellofriday.ai:5200", got)
	}

	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	if got := playgroundURL(); got != "https://local.hellofriday.ai:15200" {
		t.Errorf("playgroundURL with cert+port override = %q, want https://local.hellofriday.ai:15200", got)
	}
}

// TestPlaygroundSpec_PicksUpCertPathsViaDotEnv guards the contract
// that cert paths flow from .env (where ensureCertEnvFile writes them)
// through loadDotEnv → commonServiceEnv → every service spec. The
// launcher must not inject cert paths at spawn time — anyone running
// a service manually (via `friday daemon start`, etc.) needs to read
// the same .env and get the same wiring without the launcher.
//
// Regression target: a previous draft injected FRIDAY_BROWSER_TLS_CERT
// directly on the playground spec, which made the launcher a hard
// dependency for TLS to work.
func TestPlaygroundSpec_PicksUpCertPathsViaDotEnv(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	// Simulate the boot-time writeback: ensureCertEnvFile runs and
	// drops cert paths into .env.
	if _, err := ensureCertEnvFile(); err != nil {
		t.Fatalf("ensureCertEnvFile: %v", err)
	}

	specs := supervisedProcesses("/tmp/bin")
	var playground *processSpec
	for i := range specs {
		if specs[i].name == "playground" {
			playground = &specs[i]
			break
		}
	}
	if playground == nil {
		t.Fatal("playground spec missing")
	}
	// The launcher resolver may pick the env-var override; rely on it
	// for the expected path so this test stays correct even when a
	// shell export pins FRIDAY_BROWSER_TLS_CERT elsewhere.
	wantCert := "FRIDAY_BROWSER_TLS_CERT=" + tlsCertPath()
	wantKey := "FRIDAY_BROWSER_TLS_KEY=" + tlsKeyPath()
	wantS2sCert := "FRIDAY_TLS_CERT=" + s2sCertPath()
	wantS2sKey := "FRIDAY_TLS_KEY=" + s2sKeyPath()
	wantS2sCA := "FRIDAY_TLS_CA=" + s2sCAPath()
	for _, want := range []string{wantCert, wantKey, wantS2sCert, wantS2sKey, wantS2sCA} {
		if !slices.Contains(playground.env, want) {
			t.Errorf("playground env missing %q\nfull env: %v", want, playground.env)
		}
	}
}

func TestPlaygroundURL_FallsBackToHttpWhenCertExpired(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	tlsDir := filepath.Join(tmp, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// notBefore = now - 25h, lifetime = 24h → notAfter = now - 1h → expired.
	pastAge := 25 * time.Hour
	expiredPEM, _ := makeTestCert(t, 24*time.Hour, &pastAge)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), expiredPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.key"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	if got := playgroundURL(); got != "http://localhost:15200" {
		t.Errorf("playgroundURL with expired cert = %q, want http://localhost:15200", got)
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

// TestLoadDotEnv_StripsCRLFTrailingCR verifies that values from a .env
// file saved with CRLF line endings (e.g. opened in a Windows editor)
// don't smuggle a trailing `\r` into supervised-service env. Without this
// trim, `FRIDAY_PORT_FRIDAY=18080\r` would propagate to nats-server's
// `-sd` flag and to subprocess env, breaking URL construction.
func TestLoadDotEnv_StripsCRLFTrailingCR(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := []byte("FRIDAY_PORT_FRIDAY=18080\r\nFRIDAY_HOME=/Users/x/.friday/local\r\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}

	entries := loadDotEnv(path)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0] != "FRIDAY_PORT_FRIDAY=18080" {
		t.Errorf("port entry = %q, want FRIDAY_PORT_FRIDAY=18080 (trailing CR not stripped)", entries[0])
	}
	if entries[1] != "FRIDAY_HOME=/Users/x/.friday/local" {
		t.Errorf("home entry = %q, want FRIDAY_HOME=/Users/x/.friday/local", entries[1])
	}
}

// TestLoadDotEnv_LFOnly verifies the trim is a no-op for standard Unix
// .env files — no spurious mutation of LF-terminated values.
func TestLoadDotEnv_LFOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := []byte("FRIDAY_PORT_FRIDAY=18080\nFRIDAY_HOME=/x/.friday/local\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	entries := loadDotEnv(path)
	if len(entries) != 2 || entries[0] != "FRIDAY_PORT_FRIDAY=18080" {
		t.Errorf("unexpected entries on LF-only file: %v", entries)
	}
}

// TestLoadDotEnv_StripsCRLF_AndQuotes pins the ordering of the
// composed `unquoteEnvValue(strings.TrimRight(line[eq+1:], "\r"))`.
//
// `\r` MUST be trimmed before quote-stripping. If the order were
// reversed:
//   - line[eq+1:]                  = `"sk-ant-foo"\r`
//   - unquoteEnvValue first        = `"sk-ant-foo"\r` (last byte is
//     `\r` not `"`, so the matched-quote check refuses to strip)
//   - TrimRight after              = `"sk-ant-foo"` (the `\r` is gone
//     but the literal quotes leak through to the spawned service)
//
// PR #203 covered the LF + quoted case; the round-2 CRLF fix covered
// CRLF without quotes. This test pins the COMBINATION the rebase
// merge had to compose. A future refactor that swaps the call order
// is caught here.
func TestLoadDotEnv_StripsCRLF_AndQuotes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := []byte("API_KEY=\"sk-ant-foo\"\r\nNUM=42\r\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}

	entries := loadDotEnv(path)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d: %v", len(entries), entries)
	}
	if entries[0] != "API_KEY=sk-ant-foo" {
		t.Errorf("api_key entry = %q, want API_KEY=sk-ant-foo (CRLF + quotes both stripped)",
			entries[0])
	}
	if entries[1] != "NUM=42" {
		t.Errorf("num entry = %q, want NUM=42", entries[1])
	}
}
