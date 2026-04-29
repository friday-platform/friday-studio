package main

import (
	"os"
	"path/filepath"
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
	required := []string{"friday", "link", "pty-server", "webhook-tunnel", "playground"}
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
