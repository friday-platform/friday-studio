package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/f1bonacc1/process-compose/src/command"
	"github.com/f1bonacc1/process-compose/src/health"
	"github.com/f1bonacc1/process-compose/src/types"
)

// fridayNATSPortBase is the start of Friday's reserved NATS port range.
// Mirrors FRIDAY_NATS_PORT_BASE in packages/jetstream/src/spawn.ts —
// keep in sync. Range is `[Base, Base+Range)` (10 slots).
const (
	fridayNATSPortBase  = 14222
	fridayNATSPortRange = 10
)

// natsServerPort is picked once at launcher startup by pickNATSPort() and
// reused for both the nats-server argv and the FRIDAY_NATS_URL env we
// hand to every supervised child. Defaults to 0 to surface "forgot to
// initialize" wiring bugs in tests rather than silently spawning on a
// privileged port.
var natsServerPort int

// pickNATSPort tries to bind each port in the Friday-reserved range
// (`fridayNATSPortBase..+Range`) and returns the first one that's free.
// Falls back to an OS-assigned ephemeral port if all slots are taken
// (extreme edge case). The chosen port lands in `natsServerPort` and
// is used by both `natsServerArgs` and the `FRIDAY_NATS_URL` env that
// the launcher injects into supervised children.
//
// TOCTOU: the port may be claimed between the listener close and
// nats-server's bind. Acceptable — nats-server fails fast with a clear
// stderr error in that case and process-compose surfaces it.
func pickNATSPort() int {
	for offset := 0; offset < fridayNATSPortRange; offset++ {
		port := fridayNATSPortBase + offset
		if tryBindTCP(port) {
			return port
		}
	}
	// All reserved slots taken. Ask the kernel for any free port.
	return pickEphemeralPort()
}

func tryBindTCP(port int) bool {
	addr := "127.0.0.1:" + strconv.Itoa(port)
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

func pickEphemeralPort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		// Truly nothing free — shouldn't happen, but keep the launcher
		// going with the legacy default and let nats-server fail loudly.
		return 4222
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close() // errcheck: best-effort; the port is returned regardless
	return port
}

// natsServerURL returns the nats:// URL the broker should be reachable
// at, based on the port picked by pickNATSPort(). Empty if not yet
// initialized — caller should check.
func natsServerURL() string {
	if natsServerPort == 0 {
		return ""
	}
	return fmt.Sprintf("nats://127.0.0.1:%d", natsServerPort)
}

// osGetenv is var-bound so tests can stub it.
var osGetenv = os.Getenv

// desktopServiceDefaults are the env-var defaults the launcher always
// asserts for child services because Studio is, by definition, a
// desktop install — never a hosted production deploy.
//
//   - LINK_DEV_MODE=true: link's createPlatformRouteRepo and
//     createCommunicatorWiringRepo throw "POSTGRES_CONNECTION required
//     in production" without it. Studio has no Postgres; link has to
//     fall back to NoOpPlatformRouteRepository + SqliteCommunicatorWiring.
//
// Defaults are ONLY applied when the user's .env doesn't already provide
// the key, so an explicit override (e.g. setting LINK_DEV_MODE=false for
// a Postgres-backed local test) wins.
var desktopServiceDefaults = map[string]string{
	"LINK_DEV_MODE": "true",
}

// commonServiceEnv returns the KEY=VALUE pairs from ~/.friday/local/.env
// merged with the desktopServiceDefaults. Every supervised service gets
// this as a baseline so the values the installer's API Keys + platform-
// vars step persist (ANTHROPIC_API_KEY, EXTERNAL_DAEMON_URL,
// EXTERNAL_TUNNEL_URL, FRIDAYD_URL, …) are visible everywhere the
// launcher needs them — not just in `friday`. The launcher itself
// inherits a near-empty env when spawned from Finder/Spotlight, so
// without this merge each service would see none of the user's
// configured keys / URLs.
func commonServiceEnv() []string {
	env := loadDotEnv(filepath.Join(friendlyHome(), ".env"))
	seen := map[string]struct{}{}
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i > 0 {
			seen[kv[:i]] = struct{}{}
		}
	}
	for k, v := range desktopServiceDefaults {
		if _, ok := seen[k]; !ok {
			env = append(env, k+"="+v)
		}
	}
	// Pin every supervised service to the launcher-owned home. The friday
	// daemon's getFridayHome() reads FRIDAY_HOME first; sibling services
	// (link, webhook-tunnel, playground) that resolve their own paths via
	// the same helper need the same value, otherwise their data drifts to
	// the legacy ~/.atlas fallback while the daemon writes to
	// ~/.friday/local — homes diverge silently.
	env = append(env, "FRIDAY_HOME="+friendlyHome())
	// Pin the daemon's friday.yml search dir to the launcher-owned home.
	// atlas-daemon.ts reads `FRIDAY_CONFIG_PATH ?? process.cwd()`; under
	// the launcher cwd is whatever process-compose inherits (typically
	// `/` on macOS — no WorkingDir on the supervised ProcessConfig). The
	// installer wizard writes ~/.friday/local/friday.yml on non-Anthropic
	// installs; without this pin the daemon would never find that file
	// and would crash at boot trying to resolve Anthropic credentials.
	env = append(env, "FRIDAY_CONFIG_PATH="+friendlyHome())
	// Pin the NATS URL so every supervised child connects to the broker
	// the launcher just spawned, regardless of which Friday-reserved
	// port pickNATSPort() landed on (could be 14222 normally, 14223+
	// if a sibling install was already running, or an OS-assigned
	// ephemeral if the whole range was exhausted). Without this pin
	// the daemon would fall through to its own URL-file lookup, which
	// is correct in dev but redundant here.
	if url := natsServerURL(); url != "" {
		// Respect an operator override only if the user set it in
		// `.env` — that's an explicit "I have my own broker" signal.
		// Otherwise the launcher's picked URL wins.
		if _, ok := seen["FRIDAY_NATS_URL"]; !ok {
			env = append(env, "FRIDAY_NATS_URL="+url)
		}
	}
	// Cert paths (FRIDAY_TLS_*, FRIDAY_BROWSER_TLS_*, DENO_CERT,
	// NODE_EXTRA_CA_CERTS) are NOT injected here. The launcher writes
	// them to ~/.friday/local/.env once (via ensureCertEnvFile) and the
	// loadDotEnv() above already carried them into this baseline. Going
	// through .env keeps the launcher convenient-but-optional: anyone
	// running `friday daemon start` directly, without the launcher,
	// reads the same .env and gets the same cert wiring.
	return env
}

// fridayEnv builds the env-var list specific to the friday daemon
// process. Carries FRIDAY_CLAUDE_PATH, FRIDAY_UV_PATH, FRIDAY_UVX_PATH,
// FRIDAY_NODE_PATH, FRIDAY_NPX_PATH, FRIDAY_AGENT_BROWSER_PATH (when
// bundled binaries are present in binDir), plus the .env baseline.
// Without merging .env in here friday's platform-model validation
// fails on every fresh install — the daemon needs ANTHROPIC_API_KEY
// in its process environment.
//
// FRIDAY_CLAUDE_PATH discovery order:
//  1. Explicit user override via FRIDAY_CLAUDE_PATH set in the
//     launcher's own environment (e.g. someone debugging with a
//     specific build).
//  2. exec.LookPath("claude") — picks up the user's PATH-installed
//     binary regardless of how it was installed (npm global,
//     homebrew, the official native installer, etc.).
//  3. Common install paths the launcher checks even when PATH
//     doesn't include them — relevant when the launcher is
//     spawned from /Applications/Friday Studio.app via Finder /
//     Spotlight, where the inherited PATH is the macOS minimal
//     /usr/bin:/bin:/usr/sbin:/sbin and misses ~/.local/bin or
//     /opt/homebrew/bin.
//
// If none of the above resolves to a real file, we leave the env
// var unset — the SDK then surfaces its native "binary not found"
// error to the user, which is at least specific enough to act on.
func fridayEnv(binDir string) []string {
	var env []string
	if path := discoverClaudeBinary(); path != "" {
		env = append(env, "FRIDAY_CLAUDE_PATH="+path)
	}
	for _, name := range []string{"uv", "uvx"} {
		bin := filepath.Join(binDir, name)
		if runtime.GOOS == "windows" {
			bin += ".exe"
		}
		if _, err := os.Stat(bin); err == nil {
			env = append(env, "FRIDAY_"+strings.ToUpper(name)+"_PATH="+bin)
		}
	}
	// Pin uv's caches under <friday-home>/uv/ so managed Python interpreters
	// and wheel cache stay scoped to Friday rather than leaking into
	// ~/.local/share/uv (uv's XDG default). The daemon's user-agent spawn
	// path consumes these via FRIDAY_UV_PATH + uv run --with friday-agent-sdk
	// (apps/atlasd/src/agent-spawn.ts).
	if home := friendlyHome(); home != "" {
		env = append(env,
			"UV_PYTHON_INSTALL_DIR="+filepath.Join(home, "uv", "python"),
			"UV_CACHE_DIR="+filepath.Join(home, "uv", "cache"),
		)
	}
	// Pin the friday-agent-sdk PyPI version. The daemon spawns user agents
	// with `uv run --with friday-agent-sdk==<this>`, so bumping is a single
	// constant change in the launcher build, not per-agent. Kept here
	// (not in .env) because the version is a launcher-build artifact —
	// it pairs with the launcher binary the user installed.
	env = append(env, "FRIDAY_AGENT_SDK_VERSION="+bundledAgentSDKVersion)
	// Bundled Node distribution. Windows zip lays node.exe / npx.cmd flat
	// at the runtime root; macOS tarball nests under bin/. node-runtime/
	// is the directory the build-studio.ts EXTERNAL_BUNDLES entry stages
	// into.
	nodeRuntime := filepath.Join(binDir, "node-runtime")
	type nodeBin struct {
		envName     string
		unixSubpath string // e.g. bin/node
		winName     string // e.g. node.exe
	}
	for _, b := range []nodeBin{
		{envName: "FRIDAY_NODE_PATH", unixSubpath: "bin/node", winName: "node.exe"},
		{envName: "FRIDAY_NPX_PATH", unixSubpath: "bin/npx", winName: "npx.cmd"},
	} {
		var bin string
		if runtime.GOOS == "windows" {
			bin = filepath.Join(nodeRuntime, b.winName)
		} else {
			bin = filepath.Join(nodeRuntime, b.unixSubpath)
		}
		if _, err := os.Stat(bin); err == nil {
			env = append(env, b.envName+"="+bin)
		}
	}
	// agent-browser is a single binary at <binDir>/agent-browser shipped
	// via build-studio.ts EXTERNAL_CLIS. Friday's `web` agent invokes it
	// via execFile (packages/bundled-agents/src/web/tools/browse.ts:67);
	// surfacing the absolute path here lets start.tsx augmentPathWithTool
	// include <binDir> in the daemon's PATH so the bare-name execFile
	// call resolves.
	abPath := filepath.Join(binDir, "agent-browser")
	if runtime.GOOS == "windows" {
		abPath += ".exe"
	}
	if _, err := os.Stat(abPath); err == nil {
		env = append(env, "FRIDAY_AGENT_BROWSER_PATH="+abPath)
	}
	// commonServiceEnv() carries FRIDAY_HOME (which redirects getFridayHome
	// for every consumer — workspaces, chats, sessions, skills.db,
	// storage.db, memory, logs, .env), the .env baseline, and shared
	// LINK_DEV_MODE etc. Sibling services (link, webhook-tunnel, playground)
	// receive the same baseline; pinning FRIDAY_HOME there ensures their
	// own getFridayHome() resolves to the same launcher-owned home rather
	// than drifting to the legacy ~/.atlas fallback.
	env = append(env, commonServiceEnv()...)
	return env
}

// loadDotEnv reads a .env-style file and returns the entries as
// "KEY=VALUE" strings. Returns nil on any error (file missing,
// unreadable, malformed) — the env is best-effort; an absent .env
// just means "no installer-provided keys", which is a normal state
// for users who set their keys via shell profile instead of the
// wizard.
//
// Tolerant parser: ignores blank lines + lines starting with '#',
// trims whitespace around the key, leaves the value as-is so any
// embedded quoting / escaping the wizard wrote round-trips
// untouched. Mirrors apps/studio-installer/src-tauri/src/commands/
// env_file.rs's render side closely enough that anything
// write_env_file produces, this can read back.
// importDotEnvIntoProcessEnv loads ~/.friday/local/.env and exports each
// KV into the launcher's own process environment, preserving any value
// already present in the launcher's env (shell exports / parent process
// take precedence over the file). Required for FRIDAY_PORT_<NAME> and
// any other launcher-side knob: portOverride() reads via os.Getenv,
// which doesn't see KVs that flow only through commonServiceEnv() into
// spawned services. Without this call, a user setting
// `FRIDAY_PORT_PLAYGROUND=15200` in .env would have no effect because
// the launcher itself never observes the variable.
func importDotEnvIntoProcessEnv() {
	for _, kv := range loadDotEnv(filepath.Join(friendlyHome(), ".env")) {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		key, value := kv[:i], kv[i+1:]
		if _, alreadySet := os.LookupEnv(key); alreadySet {
			continue
		}
		_ = os.Setenv(key, value)
	}
}

func loadDotEnv(path string) []string {
	data, err := os.ReadFile(path) //nolint:gosec // launcher-controlled path under $HOME
	if err != nil {
		return nil
	}
	var out []string
	for line := range strings.SplitSeq(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		if key == "" {
			continue
		}
		// Trim trailing `\r` BEFORE unquoting so CRLF-saved files
		// (Notepad on Windows) don't smuggle a `\r` into the value
		// and then survive the quote-strip because the last byte was
		// CR rather than the matching quote. Mirrors the same trim
		// in apps/studio-installer/.../env_file.rs's parse_env_lines.
		value := unquoteEnvValue(strings.TrimRight(line[eq+1:], "\r"))
		out = append(out, key+"="+value)
	}
	return out
}

// unquoteEnvValue strips a single layer of matching surrounding quotes
// from a .env value so spawned services receive the intended string,
// not the literal quotes.
//
// Standard dotenv parsers (Node, Python, @std/dotenv) treat `KEY='v'`
// as `KEY=v`. The launcher previously left quotes attached, so any
// .env line written by atlasd's @std/dotenv stringify (which wraps
// values with non-word chars in single quotes — e.g. an API key with
// `-`) reached agents as `'sk-ant-foo'` and failed authentication.
// Stripping here is defensive: even after atlasd switched to
// unquoted-by-default writes, hand-edited .env files and pre-fix
// installs continue to work.
//
// Only strips when the leading and trailing quote match. Mismatched
// or single-sided quotes are left as-is — they're part of the value.
// Embedded escapes inside double quotes (`\n`, `\"`) are not expanded
// here; values that need them should be set via the Settings UI,
// which writes the canonical unquoted form.
func unquoteEnvValue(v string) string {
	if len(v) < 2 {
		return v
	}
	first, last := v[0], v[len(v)-1]
	if (first == '\'' || first == '"') && first == last {
		return v[1 : len(v)-1]
	}
	return v
}

// jetStreamStoreDirEnvKey is the single canonical knob for JetStream's
// on-disk store path. Written by the installer (Stream A) and dev
// script into ~/.friday/local/.env; read by the launcher (here), the
// atlas-cli `friday migrate` command (Stream B), and the daemon's
// readJetStreamConfig. All three must compute the same default if the
// key is absent — see resolveJetStreamStoreDir.
const jetStreamStoreDirEnvKey = "FRIDAY_JETSTREAM_STORE_DIR"

// resolveJetStreamStoreDir returns the absolute path to use for
// nats-server's JetStream store, plus a provenance string describing
// where the value came from.
//
// Resolution order:
//  1. FRIDAY_JETSTREAM_STORE_DIR in ~/.friday/local/.env, if present
//     and non-empty → ("env-from-dotenv").
//  2. Fallback: <friendlyHome()>/nats → ("default").
//
// Why "nats" and not "jetstream": nats-server itself appends a
// `jetstream/` segment to whatever is passed via `-sd`, so a storeDir
// named `jetstream` produces an awkward `<home>/jetstream/jetstream/$G/
// streams/...` on disk. Using `nats` gives the cleaner
// `<home>/nats/jetstream/$G/streams/...`.
//
// The fallback default MUST match the value the installer's
// write_env_file emits and the dev script writes, so an absent .env
// key resolves identically across launcher/migrate-CLI/daemon.
func resolveJetStreamStoreDir() (storeDir, source string) {
	for _, kv := range loadDotEnv(filepath.Join(friendlyHome(), ".env")) {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		if kv[:i] != jetStreamStoreDirEnvKey {
			continue
		}
		if v := strings.TrimSpace(kv[i+1:]); v != "" {
			return v, "env-from-dotenv"
		}
		// Key present but empty → treat as missing (fall through to
		// the default). Matches the contract Stream B's @std/dotenv
		// reader applies and the design doc's "missing-or-empty"
		// fallback rule.
		break
	}
	return filepath.Join(friendlyHome(), "nats"), "default"
}

// natsServerArgs builds the argv slice for the supervised nats-server
// process. Extracted as a pure function to keep the args layout (flag
// order, store-dir position) trivially assertable in tests without
// touching the surrounding spec wiring.
//
// `port` is the value picked by `pickNATSPort()` at launcher startup —
// falls back to the legacy 4222 only if `pickNATSPort()` was never
// called (typically a test that builds args without the full launcher
// init path).
func natsServerArgs(storeDir string) []string {
	port := natsServerPort
	if port == 0 {
		port = 4222
	}
	return []string{
		"--addr", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--jetstream",
		"-sd", storeDir,
		"--http_port", "8222",
	}
}

func discoverClaudeBinary() string {
	if v := osGetenv("FRIDAY_CLAUDE_PATH"); v != "" {
		if info, err := os.Stat(v); err == nil && !info.IsDir() {
			return v
		}
	}
	if path, err := exec.LookPath("claude"); err == nil {
		return path
	}
	candidates := []string{
		// Anthropic's native installer: ~/.local/bin/claude is a
		// symlink into ~/.local/share/claude/versions/<v>.
		filepath.Join(homeDir(), ".local", "bin", "claude"),
		// Anthropic's older claude-code home dir.
		filepath.Join(homeDir(), ".claude", "local", "claude"),
		// Apple Silicon homebrew default.
		"/opt/homebrew/bin/claude",
		// Intel homebrew / generic Unix prefix.
		"/usr/local/bin/claude",
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return ""
}

// signalSIGTERM is the literal POSIX SIGTERM value (15). Using a
// literal here (rather than int(syscall.SIGTERM)) keeps this file
// cross-platform safe — Go's syscall package only defines SIGTERM on
// Unix. process-compose's Windows stopper discards the signal value
// anyway and uses taskkill /F.
const signalSIGTERM = 15

// startOrder is the dependency order; processes are started in this
// order so that producers come up first. Also drives RestartAll
// (Supervisor.RestartAll iterates this slice calling RestartProcess
// on each so foundational services come back first). nats-server
// must come up before `friday` so atlasd's NatsManager tcpProbe
// finds an external NATS on :4222 and reuses it instead of trying
// to spawn its own.
var startOrder = []string{
	"nats-server",
	"friday",
	"link",
	"webhook-tunnel",
	"playground",
}

// processSpec captures the minimal launcher-side knowledge of one
// supervised binary. Used to drive both the actual ProcessConfig
// build AND tests that exercise restart-all order.
type processSpec struct {
	name       string
	binary     string // executable path resolved at boot time
	args       []string
	env        []string // KEY=VALUE pairs added to the child's env
	healthPort string
	healthPath string
}

// supervisedProcessNames returns just the names of the supervised
// processes — used by pre-flight (which only needs names, not full
// specs) without paying the cost of building processSpecs that get
// thrown away. Single source of truth for the cardinality + ordering
// of the supervised set.
func supervisedProcessNames() []string {
	return []string{
		"nats-server",
		"friday",
		"link",
		"webhook-tunnel",
		"playground",
	}
}

// supervisedProcesses returns the launcher's view of the 5 platform
// binaries. Each entry pairs a process name with its on-disk binary
// and health probe target.
//
// The actual binaries are expected to live alongside the launcher in
// the platform tarball. For QA / stub-based local dev, individual
// ports can be overridden via env vars FRIDAY_PORT_<NAME>
// (e.g. FRIDAY_PORT_PLAYGROUND=15200) so that tests don't collide
// with a developer's real Friday instance running on the production
// ports.
func supervisedProcesses(binDir string) []processSpec {
	// Resolve JetStream store dir once per call. The launcher logs the
	// path + source separately on startup (see main.go onReady); this
	// site only needs the value to wire into nats-server's args.
	jetstreamStoreDir, _ := resolveJetStreamStoreDir()

	specs := []processSpec{
		// `nats-server` MUST start before `friday` — atlasd's
		// NatsManager probes 127.0.0.1:4222 at boot and reuses an
		// external NATS if found, otherwise it tries to spawn its
		// own (which fails on installs that don't bundle nats-server
		// at the embedded location). Bundling + supervising it here
		// gives a single source of truth for the NATS lifecycle.
		//
		// --jetstream enables persistent streams (required by atlas
		// session/event flows). --http_port 8222 exposes /healthz on
		// the monitoring HTTP server so process-compose can probe
		// readiness via the same HttpProbe machinery used by everyone
		// else (NATS itself doesn't speak HTTP on the protocol port).
		{
			name: "nats-server", binary: filepath.Join(binDir, "nats-server"),
			// `--addr 127.0.0.1` binds both the protocol port (4222)
			// and the monitoring HTTP server (8222) to loopback only.
			// Desktop installs are single-machine; nats-server holds
			// session/event traffic + JetStream state, none of which
			// should be reachable from the LAN. atlasd's NatsManager
			// connects via 127.0.0.1:4222 so loopback-only is fine.
			//
			// `-sd <storeDir>` pins JetStream's on-disk store under a
			// stable, well-known path. The path is resolved from
			// FRIDAY_JETSTREAM_STORE_DIR in ~/.friday/local/.env
			// (installer-written) with a launcher-computed fallback to
			// <friendlyHome()>/jetstream. The same default is computed
			// identically across writers (installer, dev script) and
			// readers (this launcher, atlas-cli `friday migrate`,
			// daemon `readJetStreamConfig`), so an absent value
			// resolves identically everywhere.
			args:       natsServerArgs(jetstreamStoreDir),
			healthPort: "8222", healthPath: "/healthz",
		},
		// `friday` is the atlas-cli daemon binary. Without an explicit
		// subcommand it errors with "No command specified" and exits;
		// `daemon start` runs the workspace server in foreground (we
		// own background-ness via process-compose, so no --detached).
		//
		// FRIDAY_CLAUDE_PATH points at the Claude Code native binary
		// the agent SDK invokes per request. The deno-compiled friday
		// binary doesn't bundle the platform-specific
		// claude-agent-sdk-darwin-arm64 / -windows-x64 native package,
		// so without this env var the SDK fails with "Claude Code
		// native binary not found". We discover the user's installed
		// claude on PATH (and a few common install dirs) at launcher
		// startup and surface it here. Agents fail loudly in friday
		// when this var is unset OR the path doesn't exist; users
		// without claude installed see the original SDK error message
		// (which now points them at a working install command).
		{
			name: "friday", binary: filepath.Join(binDir, "friday"),
			args:       []string{"daemon", "start"},
			env:        fridayEnv(binDir),
			healthPort: "8080", healthPath: "/health",
		},
		// `link` historically required LINK_DEV_MODE=true to skip the
		// POSTGRES_CONNECTION check on the platform-route + slack-app
		// repos. The installer now writes that into .env, so the
		// commonServiceEnv() baseline below carries it; no per-service
		// override needed.
		{
			name: "link", binary: filepath.Join(binDir, "link"),
			env:        commonServiceEnv(),
			healthPort: "3100", healthPath: "/health",
		},
		{
			name: "webhook-tunnel", binary: filepath.Join(binDir, "webhook-tunnel"),
			env:        commonServiceEnv(),
			healthPort: "9090", healthPath: "/health",
		},
		{
			// Decision #32: the readiness probe MUST exercise the
			// real handler stack at a public entry point — that's
			// what makes "all healthy" actually mean "all usable".
			// Playground is a SvelteKit app whose root path is a
			// public landing; probing `/` catches the SvelteKit-
			// not-yet-bound race that a sidecar `/api/health` would
			// silently green-light. project_test.go pins this so a
			// future refactor can't quietly revert to the sidecar.
			//
			// Carries .env so EXTERNAL_DAEMON_URL / EXTERNAL_TUNNEL_URL
			// reach static-server.ts, which injects them into the
			// served HTML for the browser's window.__FRIDAY_CONFIG__.
			name: "playground", binary: filepath.Join(binDir, "playground"),
			// commonServiceEnv() now carries FRIDAY_BROWSER_TLS_CERT/_KEY
			// (and the s2s + DENO_CERT / NODE_EXTRA_CA_CERTS pins) for
			// every service — no playground-specific env wiring needed
			// here.
			env:        commonServiceEnv(),
			healthPort: "5200", healthPath: "/",
		},
	}
	for i, s := range specs {
		port := portOverride(s.name)
		if port == "" {
			continue
		}
		// Update the launcher's own readiness probe so it watches the
		// right socket.
		specs[i].healthPort = port
		// Propagate the override into the supervised binary itself.
		// Each service exposes its own port-config knob — the launcher
		// has to know about each, since (a) the bind-port mechanism
		// differs (CLI flag vs env var) and (b) the env var names
		// don't match the launcher's FRIDAY_PORT_* convention.
		switch s.name {
		case "friday":
			// atlas-cli reads `--port <n>` (apps/atlas-cli/.../daemon/
			// start.tsx:68). Append after `daemon start`; yargs accepts
			// flag-after-positional for parsed args.
			specs[i].args = append(specs[i].args, "--port", port)
		case "link":
			// apps/link/src/config.ts:40 reads LINK_PORT (default 3100).
			specs[i].env = append(specs[i].env, "LINK_PORT="+port)
		case "webhook-tunnel":
			// tools/webhook-tunnel/main.go:11 reads TUNNEL_PORT
			// (default 9090).
			specs[i].env = append(specs[i].env, "TUNNEL_PORT="+port)
		case "playground":
			// tools/agent-playground/static-server.ts:18 reads
			// PLAYGROUND_PORT (default 5200).
			specs[i].env = append(specs[i].env, "PLAYGROUND_PORT="+port)
		case "nats-server":
			// nats-server uses --port <n> at index 1 of its args; the
			// monitoring --http_port stays on the default 8222 so the
			// healthPort override above is a no-op for nats. We don't
			// expose nats-server's protocol port via FRIDAY_PORT_*
			// today — atlasd's NatsManager probes the well-known 4222
			// (apps/atlasd/src/nats-manager.ts), so moving it would
			// also require coordinated env wiring on the daemon side.
			// Skip until there's a real need.
		}
	}
	return specs
}

func portOverride(name string) string {
	// Env vars use the conventional uppercase shape, with hyphens swapped
	// for underscores (POSIX rules): FRIDAY_PORT_WEBHOOK_TUNNEL, not
	// FRIDAY_PORT_webhook-tunnel.
	envName := "FRIDAY_PORT_" + strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
	return osGetenv(envName)
}

// playgroundURL returns the URL the tray opens in the user's browser
// when the platform reaches "all healthy". Honors the
// FRIDAY_PORT_playground override so installs that move playground off
// 5200 (e.g. to avoid collision with another local Friday instance) get
// the right URL — without this the tray click silently lands on the
// wrong port and the user sees a "can't connect" page.
//
// Scheme/host: when the browser-trusted cert pair downloaded by the
// installer (apps/studio-installer/src-tauri/src/commands/download_tls.rs)
// is present at <friendlyHome()>/tls/browser.crt, the playground binary
// is listening on TLS for `local.hellofriday.ai` — a public DNS name
// that resolves to 127.0.0.1, with a Let's Encrypt cert in the SAN. We
// open the https URL so the browser lands on a green-lock origin that
// matches the cert. Without the cert, fall back to http://localhost so
// dev/source installs and any install that failed the cert download
// still work.
func playgroundURL() string {
	port := portOverride("playground")
	if port == "" {
		port = "5200"
	}
	if hasValidBrowserCert() {
		return "https://local.hellofriday.ai:" + port
	}
	return "http://localhost:" + port
}

// newProjectFromSpecs builds the typed types.Project from a list of
// process specs. Health probes, restart policy, and shutdown timeout
// are uniform across all specs.
func newProjectFromSpecs(specs []processSpec) *types.Project {
	procs := types.Processes{}
	for _, s := range specs {
		// process-compose's process.go reads Executable + Args directly
		// (see src/app/process.go:287-300). The YAML loader translates
		// Entrypoint -> Executable + Args via
		// ProcessConfig.AssignProcessExecutableAndArgs, but
		// NewProjectRunner does NOT call that translator. So when we
		// build types.Project programmatically we must set Executable
		// and Args ourselves.
		//
		// Same story for ReplicaName / Replicas: the loader's
		// cloneReplicas() pass populates ReplicaName from Name when
		// Replicas == 1. NewProjectRunner doesn't call that either,
		// so we set Replicas=1 + ReplicaName=Name here.
		procs[s.name] = types.ProcessConfig{
			Name:        s.name,
			ReplicaName: s.name,
			Replicas:    1,
			Executable:  s.binary,
			Args:        s.args,
			Environment: types.Environment(s.env),
			LogLocation: processLogPath(s.name),
			RestartPolicy: types.RestartPolicyConfig{
				Restart:        types.RestartPolicyAlways,
				BackoffSeconds: 2,
				MaxRestarts:    supervisedMaxRestarts,
			},
			ReadinessProbe: &health.Probe{
				// Cold-start tolerance: 2s initial + 30 failures × 2s
				// = 62s window before process-compose declares the
				// process unhealthy and restarts it. The friday daemon
				// alone takes ~24s on first boot (workspace scan + skill
				// bundle hashing + cron registration), and playground's
				// SvelteKit-first-render takes another ~6-8s. The old
				// 12s window (5 × 2s) was enough for warm restarts but
				// not for the very first launch after install — every
				// supervised process bounced 1-3 times before stabilizing,
				// surfacing as a "Daemon unreachable" flash in the UI.
				InitialDelay:     2,
				PeriodSeconds:    2,
				TimeoutSeconds:   2,
				FailureThreshold: 30,
				SuccessThreshold: 1,
				HttpGet: &health.HttpProbe{
					Host:   "127.0.0.1",
					Port:   s.healthPort,
					Path:   s.healthPath,
					Scheme: "http",
				},
			},
			ShutDownParams: types.ShutDownParams{
				ShutDownTimeout: 10,            // seconds; SIGKILL after this
				Signal:          signalSIGTERM, // 15 — cross-platform-safe literal
			},
		}
	}
	return &types.Project{
		Version:           "0.5",
		Name:              "Friday Studio",
		Processes:         procs,
		IsOrderedShutdown: true,
		// process.go line 214 dereferences ShellConfig — must be
		// non-nil even though we never use shell-mode (we use
		// Executable+Args). The loader sets this via
		// command.DefaultShellConfig(); we do the same.
		ShellConfig: command.DefaultShellConfig(),
	}
}
