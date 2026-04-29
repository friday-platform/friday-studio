package main

import (
	"os"
	"path/filepath"
	"slices"
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

// TestCommonServiceEnv_AppliesDesktopDefaults asserts the launcher
// always sets LINK_DEV_MODE / DEV_MODE for child services when the
// .env doesn't override them. Pre-2026-04: link crashed every desktop
// install with "POSTGRES_CONNECTION required in production" because
// nothing was telling it this was a dev/desktop run.
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
		"DEV_MODE=true",
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
