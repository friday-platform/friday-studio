package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/f1bonacc1/process-compose/src/command"
	"github.com/f1bonacc1/process-compose/src/health"
	"github.com/f1bonacc1/process-compose/src/types"
)

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
func loadDotEnv(path string) []string {
	data, err := os.ReadFile(path) //nolint:gosec // launcher-controlled path under $HOME
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(data), "\n") {
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
		value := line[eq+1:]
		out = append(out, key+"="+value)
	}
	return out
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

// stopOrder is the REVERSE-dependency order; processes are stopped in
// this order so that consumers (e.g. playground) go down before the
// services they depend on.
var stopOrder = []string{
	"playground",
	"webhook-tunnel",
	"friday",
	"link",
	"nats-server",
}

// startOrder is the dependency order; processes are started in this
// order so that producers come up first. nats-server must come up
// before `friday` so atlasd's NatsManager tcpProbe finds an external
// NATS on :4222 and reuses it instead of trying to spawn its own.
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
// ports can be overridden via env vars FRIDAY_PORT_<name>
// (e.g. FRIDAY_PORT_playground=15200) so that tests don't collide
// with a developer's real Friday instance running on the production
// ports.
func supervisedProcesses(binDir string) []processSpec {
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
			args:       []string{"--port", "4222", "--jetstream", "--http_port", "8222"},
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
	// Hyphens aren't valid in POSIX env var names, so swap them for
	// underscores: FRIDAY_PORT_webhook_tunnel, not FRIDAY_PORT_webhook-tunnel.
	envName := "FRIDAY_PORT_" + strings.ReplaceAll(name, "-", "_")
	return osGetenv(envName)
}

// playgroundURL returns the loopback URL the tray opens in the user's
// browser when the platform reaches "all healthy". Honors the
// FRIDAY_PORT_playground override so installs that move playground off
// 5200 (e.g. to avoid collision with another local Friday instance) get
// the right URL — without this the tray click silently lands on the
// wrong port and the user sees a "can't connect" page.
func playgroundURL() string {
	port := portOverride("playground")
	if port == "" {
		port = "5200"
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
