package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/f1bonacc1/process-compose/src/command"
	"github.com/f1bonacc1/process-compose/src/health"
	"github.com/f1bonacc1/process-compose/src/types"
)

// osGetenv is var-bound so tests can stub it.
var osGetenv = os.Getenv

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
	"pty-server",
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
	"pty-server",
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
		"pty-server",
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
		{
			name: "friday", binary: filepath.Join(binDir, "friday"),
			args:       []string{"daemon", "start"},
			healthPort: "8080", healthPath: "/health",
		},
		// `link` requires LINK_DEV_MODE=true to skip the
		// POSTGRES_CONNECTION check on the platform-route + slack-app
		// repos. Local installs don't have Postgres; the dev-mode
		// in-memory NoOp repos are correct.
		{
			name: "link", binary: filepath.Join(binDir, "link"),
			env:        []string{"LINK_DEV_MODE=true"},
			healthPort: "3100", healthPath: "/health",
		},
		{
			name: "pty-server", binary: filepath.Join(binDir, "pty-server"),
			healthPort: "7681", healthPath: "/health",
		},
		{
			name: "webhook-tunnel", binary: filepath.Join(binDir, "webhook-tunnel"),
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
			name: "playground", binary: filepath.Join(binDir, "playground"),
			healthPort: "5200", healthPath: "/",
		},
	}
	for i, s := range specs {
		if v := portOverride(s.name); v != "" {
			specs[i].healthPort = v
		}
	}
	return specs
}

func portOverride(name string) string {
	// Hyphens aren't valid in POSIX env var names, so swap them for
	// underscores: FRIDAY_PORT_pty_server, not FRIDAY_PORT_pty-server.
	envName := "FRIDAY_PORT_" + strings.ReplaceAll(name, "-", "_")
	return osGetenv(envName)
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
				InitialDelay:     2, // seconds
				PeriodSeconds:    2,
				TimeoutSeconds:   2,
				FailureThreshold: 5,
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
