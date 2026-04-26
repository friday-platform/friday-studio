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

// signalSIGKILL is sent on hard-kill paths (timeout exceeded).
const signalSIGKILL = 9

// stopOrder is the REVERSE-dependency order; processes are stopped in
// this order so that consumers (e.g. playground) go down before the
// services they depend on.
var stopOrder = []string{
	"playground",
	"pty-server",
	"webhook-tunnel",
	"friday",
	"link",
}

// startOrder is the dependency order; processes are started in this
// order so that producers come up first.
var startOrder = []string{
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
	name        string
	binary      string  // executable path resolved at boot time
	args        []string
	healthPort  string
	healthPath  string
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
		{name: "friday", binary: filepath.Join(binDir, "friday"),
			healthPort: "8080", healthPath: "/health"},
		{name: "link", binary: filepath.Join(binDir, "link"),
			healthPort: "3100", healthPath: "/health"},
		{name: "pty-server", binary: filepath.Join(binDir, "pty-server"),
			healthPort: "7681", healthPath: "/health"},
		{name: "webhook-tunnel", binary: filepath.Join(binDir, "webhook-tunnel"),
			healthPort: "9090", healthPath: "/health"},
		{name: "playground", binary: filepath.Join(binDir, "playground"),
			healthPort: "5200", healthPath: "/api/health"},
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
			LogLocation: processLogPath(s.name),
			RestartPolicy: types.RestartPolicyConfig{
				Restart:        types.RestartPolicyAlways,
				BackoffSeconds: 2,
				MaxRestarts:    5,
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
