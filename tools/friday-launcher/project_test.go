package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestPlaygroundProbePath_IsRoot pins the playground readiness probe
// to "/" — the public SvelteKit landing page — per Decision #32. A
// sidecar like "/api/health" returns 200 even before SvelteKit has
// bound the root route, which silently green-lights "all healthy"
// while a user-side request to / would still 404. Pinning this
// catches a future refactor that quietly reverts to the sidecar.
func TestPlaygroundProbePath_IsRoot(t *testing.T) {
	specs := supervisedProcesses("/tmp/dummy-bin")
	for _, s := range specs {
		if s.name != "playground" {
			continue
		}
		if s.healthPath != "/" {
			t.Errorf("playground healthPath = %q, want %q (Decision #32)",
				s.healthPath, "/")
		}
		if s.healthPort != "5200" {
			t.Errorf("playground healthPort = %q, want %q",
				s.healthPort, "5200")
		}
		return
	}
	t.Fatal("playground not found in supervisedProcesses")
}

// TestSupervisedProcessesProbeShape covers the universal contract —
// every supervised service has a non-empty healthPort + healthPath,
// and the path starts with "/". Catches a typo regression that
// would skip the http.DefaultTransport host-prefix step.
func TestSupervisedProcessesProbeShape(t *testing.T) {
	specs := supervisedProcesses("/tmp/dummy-bin")
	if len(specs) == 0 {
		t.Fatal("supervisedProcesses returned 0 entries")
	}
	for _, s := range specs {
		if s.healthPort == "" {
			t.Errorf("%s: empty healthPort", s.name)
		}
		if s.healthPath == "" {
			t.Errorf("%s: empty healthPath", s.name)
		}
		if len(s.healthPath) > 0 && s.healthPath[0] != '/' {
			t.Errorf("%s: healthPath %q must start with /", s.name, s.healthPath)
		}
	}
}

// TestSupervisedProcessesPinSet pins the exact set of supervised
// service names. CLAUDE.md documents 6 services + the wizard's
// checklist UI is sized for 6 rows; a refactor that accidentally
// drops one (e.g. webhook-tunnel) would silently shrink the set
// and the wizard would render fewer rows without anyone noticing.
// This test forces a deliberate update when intentionally
// adding/removing a service.
func TestSupervisedProcessesPinSet(t *testing.T) {
	want := []string{
		"nats-server",
		"friday",
		"link",
		"webhook-tunnel",
		"playground",
	}
	specs := supervisedProcesses("/tmp/dummy-bin")
	got := make([]string, len(specs))
	for i, s := range specs {
		got[i] = s.name
	}
	if len(got) != len(want) {
		t.Fatalf("supervisedProcesses count = %d, want %d (got=%v)",
			len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("supervisedProcesses[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestFridayLivenessListener_DefaultPort pins the friday daemon's
// dedicated liveness listener wiring when no port override is set.
// The launcher probes <port>+1 (8081) rather than the main /health
// route on the agent-bearing listener — bypassing Hono routing +
// middleware, and isolating the probe from the main port's accept
// queue. With no FRIDAY_PORT_FRIDAY override, the launcher does NOT
// pass --health-port; atlas-cli's deriveHealthPort defaults to
// port+1 = 8081, which matches the spec's healthPort here. See
// AtlasDaemonOptions.healthPort in apps/atlasd/src/atlas-daemon.ts.
func TestFridayLivenessListener_DefaultPort(t *testing.T) {
	t.Setenv("FRIDAY_PORT_FRIDAY", "")
	specs := supervisedProcesses("/tmp/dummy-bin")
	var friday *processSpec
	for i := range specs {
		if specs[i].name == "friday" {
			friday = &specs[i]
			break
		}
	}
	if friday == nil {
		t.Fatal("friday not found in supervisedProcesses")
	}
	if friday.healthPort != "8081" {
		t.Errorf("friday healthPort = %q, want %q (default 8080 + 1)",
			friday.healthPort, "8081")
	}
	if friday.healthPath != "/" {
		t.Errorf("friday healthPath = %q, want %q (dedicated listener responds to any path)",
			friday.healthPath, "/")
	}
	// On the no-override path we deliberately do NOT pass --health-port;
	// the daemon's own default (port+1) is the single source of truth.
	joined := strings.Join(friday.args, " ")
	if strings.Contains(joined, "--health-port") {
		t.Errorf("friday args should NOT pass --health-port without an override\ngot: %s", joined)
	}
}

// TestSupervisedProcesses_PortOverride_UpperBound pins the upper end
// of the accepted range. The launcher caps overrides at 65500 (not
// 65535) so friday's liveness listener at <port>+1 always has room
// without special-casing the 16-bit boundary. 65500 must be accepted
// and propagate cleanly; 65501 must be rejected.
func TestSupervisedProcesses_PortOverride_UpperBound(t *testing.T) {
	t.Run("65500-accepted", func(t *testing.T) {
		t.Setenv("FRIDAY_PORT_FRIDAY", "65500")
		specs := supervisedProcesses("/tmp/dummy-bin")
		var friday *processSpec
		for i := range specs {
			if specs[i].name == "friday" {
				friday = &specs[i]
				break
			}
		}
		if friday == nil {
			t.Fatal("friday not found in supervisedProcesses")
		}
		if friday.healthPort != "65501" {
			t.Errorf("friday healthPort = %q, want %q (port+1)", friday.healthPort, "65501")
		}
		joined := strings.Join(friday.args, " ")
		if !strings.Contains(joined, "--port 65500") {
			t.Errorf("friday args missing --port 65500\ngot: %s", joined)
		}
		if !strings.Contains(joined, "--health-port 65501") {
			t.Errorf("friday args missing --health-port 65501\ngot: %s", joined)
		}
	})

	t.Run("65501-rejected", func(t *testing.T) {
		t.Setenv("FRIDAY_PORT_FRIDAY", "65501")
		specs := supervisedProcesses("/tmp/dummy-bin")
		var friday *processSpec
		for i := range specs {
			if specs[i].name == "friday" {
				friday = &specs[i]
				break
			}
		}
		if friday == nil {
			t.Fatal("friday not found in supervisedProcesses")
		}
		// Out-of-range override is rejected; spec stays at defaults.
		if friday.healthPort != "8081" {
			t.Errorf("friday healthPort = %q, want %q (rejected override leaves default)",
				friday.healthPort, "8081")
		}
	})
}

// TestSupervisedProcesses_BadPortOverride_IsIgnored covers the
// non-numeric / out-of-range port override path that previously
// would have set healthPort to a string the readiness probe could
// never resolve (e.g. https://127.0.0.1:abc/). The override is
// rejected at spec-build time and the service keeps its default.
func TestSupervisedProcesses_BadPortOverride_IsIgnored(t *testing.T) {
	cases := []struct {
		name string
		env  string
	}{
		{"non-numeric", "abc"},
		{"empty-after-set", "  "},
		{"out-of-range-high", "70000"},
		{"just-above-cap", "65501"}, // upper bound is 65500
		{"out-of-range-low", "0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("FRIDAY_PORT_FRIDAY", tc.env)
			specs := supervisedProcesses("/tmp/dummy-bin")
			var friday *processSpec
			for i := range specs {
				if specs[i].name == "friday" {
					friday = &specs[i]
					break
				}
			}
			if friday == nil {
				t.Fatal("friday not found in supervisedProcesses")
			}
			if friday.healthPort != "8081" {
				t.Errorf("friday healthPort = %q, want %q (bad override should leave default)",
					friday.healthPort, "8081")
			}
			joined := strings.Join(friday.args, " ")
			if strings.Contains(joined, "--port "+tc.env) {
				t.Errorf("friday args should NOT propagate bad override %q\ngot: %s", tc.env, joined)
			}
		})
	}
}

// TestCommonServiceEnv_AppliesDesktopDefaults asserts the launcher
// always sets LINK_DEV_MODE for child services when the .env doesn't
// override it. Pre-2026-04: link crashed every desktop install with
// "POSTGRES_CONNECTION required in production" because nothing was
// telling it this was a dev/desktop run.
func TestCommonServiceEnv_AppliesDesktopDefaults(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	envDir := filepath.Join(tmp, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(envDir, ".env"),
		[]byte("ANTHROPIC_API_KEY=sk-test\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := commonServiceEnv()
	for _, want := range []string{
		"ANTHROPIC_API_KEY=sk-test",
		"LINK_DEV_MODE=true",
	} {
		if !slices.Contains(got, want) {
			t.Errorf("commonServiceEnv missing %q. got=%v", want, got)
		}
	}
}

// TestCommonServiceEnv_RespectsExplicitOverride verifies a user can
// disable the desktop defaults from .env (e.g. LINK_DEV_MODE=false to
// force the Postgres-backed code path during local Postgres testing).
func TestCommonServiceEnv_RespectsExplicitOverride(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	envDir := filepath.Join(tmp, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(envDir, ".env"),
		[]byte("LINK_DEV_MODE=false\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := commonServiceEnv()
	if slices.Contains(got, "LINK_DEV_MODE=true") {
		t.Errorf("explicit LINK_DEV_MODE=false was clobbered by default. got=%v", got)
	}
	if !slices.Contains(got, "LINK_DEV_MODE=false") {
		t.Errorf("user's LINK_DEV_MODE=false missing from env. got=%v", got)
	}
}

// TestStartOrderConfig pins startOrder, the dependency order
// Supervisor.RestartAll iterates over when calling RestartProcess
// on each supervised service. nats-server must come first so the
// friday daemon's NatsManager tcpProbe finds an external NATS on
// :4222 and reuses it instead of spawning its own; playground
// comes last so it doesn't surface a spurious "backend down" UI
// flash while its upstreams are still warming up. A reorder here
// without a corresponding probe/dependency review can cause the
// "Daemon unreachable" flash that the readiness budget widening
// (Decision #?: 12s → 62s) was supposed to eliminate.
func TestStartOrderConfig(t *testing.T) {
	want := []string{
		"nats-server", "friday", "link", "webhook-tunnel", "playground",
	}
	if !slices.Equal(startOrder, want) {
		t.Errorf("startOrder mismatch:\n want %q\n  got %q", want, startOrder)
	}
}
