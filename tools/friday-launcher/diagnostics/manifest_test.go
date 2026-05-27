package diagnostics

import (
	"strings"
	"testing"
	"time"
)

// TestManifest_Golden pins the exact byte shape of the manifest so
// downstream support tooling (which greps / parses these files) is
// not destabilized by a stray field rename or yaml-emitter quirk.
// The privacy header is part of the contract — it's the user-visible
// "logs are not redacted" disclaimer — and must come first.
func TestManifest_Golden(t *testing.T) {
	m := manifest{
		DaemonVersion:              "unreachable",
		OS:                         "darwin",
		Arch:                       "arm64",
		GeneratedAt:                time.Date(2026, 5, 28, 12, 34, 56, 0, time.UTC),
		IncludeWorkspacesRequested: false,
		Included: manifestIncluded{
			Logs:       []string{"daemon.log", "launcher.log"},
			StateJSON:  true,
			Pids:       true,
			Workspaces: false,
		},
		Skipped: []manifestSkip{
			{What: "workspaces", Why: "user_opted_out"},
		},
	}

	got, err := marshalManifest(m)
	if err != nil {
		t.Fatalf("marshalManifest: %v", err)
	}

	want := `# Friday diagnostic export
#
# Workspace bundles (if present) have credentials stripped.
# Log files are NOT redacted — review the contents of logs/
# before sharing this archive publicly.

daemon_version: unreachable
os: darwin
arch: arm64
generated_at: 2026-05-28T12:34:56Z
include_workspaces_requested: false
included:
    logs:
        - daemon.log
        - launcher.log
    state_json: true
    pids: true
    workspaces: false
skipped:
    - what: workspaces
      why: user_opted_out
`

	if string(got) != want {
		t.Errorf("manifest mismatch.\n--- got ---\n%s--- want ---\n%s", got, want)
		// Hint at first divergent line for fast debugging.
		gotLines := strings.Split(string(got), "\n")
		wantLines := strings.Split(want, "\n")
		for i := 0; i < len(gotLines) && i < len(wantLines); i++ {
			if gotLines[i] != wantLines[i] {
				t.Logf("first diff at line %d:\n  got:  %q\n  want: %q", i+1, gotLines[i], wantLines[i])
				break
			}
		}
	}
}

// TestManifest_DaemonUnreachableSkipReason covers the IncludeWorkspaces=true
// path that this slice can't actually fulfill (no HTTP yet). The skip token
// is part of the public manifest contract — the next task swaps how it's
// computed, not what string lands on disk.
func TestManifest_DaemonUnreachableSkipReason(t *testing.T) {
	m := manifest{
		DaemonVersion:              "unreachable",
		OS:                         "linux",
		Arch:                       "amd64",
		GeneratedAt:                time.Date(2026, 5, 28, 0, 0, 0, 0, time.UTC),
		IncludeWorkspacesRequested: true,
		Included: manifestIncluded{
			Logs:       []string{},
			StateJSON:  true,
			Pids:       true,
			Workspaces: false,
		},
		Skipped: []manifestSkip{
			{What: "workspaces", Why: "daemon_unreachable"},
		},
	}

	got, err := marshalManifest(m)
	if err != nil {
		t.Fatalf("marshalManifest: %v", err)
	}
	if !strings.Contains(string(got), "why: daemon_unreachable") {
		t.Errorf("expected daemon_unreachable in skip body, got:\n%s", got)
	}
	if !strings.Contains(string(got), "include_workspaces_requested: true") {
		t.Errorf("expected include_workspaces_requested: true, got:\n%s", got)
	}
}
