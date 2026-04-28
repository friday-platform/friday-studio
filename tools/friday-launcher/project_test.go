package main

import (
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
