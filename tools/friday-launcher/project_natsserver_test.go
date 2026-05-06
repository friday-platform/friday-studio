package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestNatsServerArgs_ContainsStoreDirInRightPosition asserts the
// argv layout for nats-server: `-sd <storeDir>` MUST live between
// `--jetstream` and `--http_port`. nats-server's argument parser
// itself doesn't care about ordering, but the launcher's contract
// (and the v6 plan's "Final args shape") pins the layout so a
// future refactor that quietly drops the flag is caught at the
// unit level rather than at runtime when JetStream silently writes
// to $TMPDIR again.
func TestNatsServerArgs_ContainsStoreDirInRightPosition(t *testing.T) {
	args := natsServerArgs("/tmp/some/store")
	want := []string{
		"--addr", "127.0.0.1",
		"--port", "4222",
		"--jetstream",
		"-sd", "/tmp/some/store",
		"--http_port", "8222",
	}
	if !slices.Equal(args, want) {
		t.Fatalf("natsServerArgs(/tmp/some/store) = %v\nwant %v", args, want)
	}
}

// TestSupervisedProcesses_NatsServerHonorsExplicitStoreDir pins that
// when .env carries FRIDAY_JETSTREAM_STORE_DIR, the constructed
// nats-server process spec passes that value as `-sd`. End-to-end
// guard: catches regressions in either the .env-load wiring or the
// args-builder wiring as a single failure rather than two separate
// holes.
func TestSupervisedProcesses_NatsServerHonorsExplicitStoreDir(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	explicit := "/some/explicit/path"
	if err := os.WriteFile(filepath.Join(envDir, ".env"),
		[]byte("FRIDAY_JETSTREAM_STORE_DIR="+explicit+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)

	storeDir, source := resolveJetStreamStoreDir()
	if storeDir != explicit {
		t.Errorf("resolveJetStreamStoreDir storeDir = %q, want %q", storeDir, explicit)
	}
	if source != "env-from-dotenv" {
		t.Errorf("resolveJetStreamStoreDir source = %q, want env-from-dotenv", source)
	}

	specs := supervisedProcesses("/tmp/bin")
	nats := findNatsSpec(t, specs)

	assertSdArg(t, nats.args, explicit)
}

// TestSupervisedProcesses_NatsServerDefaultsWhenKeyMissing pins that
// an .env without the key resolves to <friendlyHome()>/nats. This is
// the canonical default the writers (installer, dev script) also
// emit, so an absent key + present key must produce identical args
// for the launcher.
func TestSupervisedProcesses_NatsServerDefaultsWhenKeyMissing(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// .env present but lacking the key — exercises the read path
	// without a "file missing" shortcut.
	if err := os.WriteFile(filepath.Join(envDir, ".env"),
		[]byte("LINK_DEV_MODE=true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)
	// Make friendlyHome() resolve to the test-owned dir regardless of
	// the surrounding test process's HOME interpretation. Without this
	// pin a stale FRIDAY_LAUNCHER_HOME from another test or the
	// developer's shell would leak in. `t.Setenv("…", "")` over
	// `os.Unsetenv` so the runtime auto-restores at test end —
	// friendlyHome() treats empty and unset identically.
	t.Setenv("FRIDAY_LAUNCHER_HOME", "")

	wantDefault := filepath.Join(tmpHome, ".friday", "local", "nats")

	storeDir, source := resolveJetStreamStoreDir()
	if storeDir != wantDefault {
		t.Errorf("resolveJetStreamStoreDir storeDir = %q, want %q", storeDir, wantDefault)
	}
	if source != "default" {
		t.Errorf("resolveJetStreamStoreDir source = %q, want default", source)
	}

	specs := supervisedProcesses("/tmp/bin")
	nats := findNatsSpec(t, specs)
	assertSdArg(t, nats.args, wantDefault)
}

// TestSupervisedProcesses_NatsServerEmptyValueFallsBack pins the
// "key present but empty" branch. Stream B's @std/dotenv reader
// treats an empty value the same as a missing key; the Go launcher
// must match so the broker doesn't accidentally pass `-sd ""` to
// nats-server.
func TestSupervisedProcesses_NatsServerEmptyValueFallsBack(t *testing.T) {
	tmpHome := t.TempDir()
	envDir := filepath.Join(tmpHome, ".friday", "local")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(envDir, ".env"),
		[]byte("FRIDAY_JETSTREAM_STORE_DIR=\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", tmpHome)
	// See note on `t.Setenv("…", "")` in
	// TestSupervisedProcesses_NatsServerDefaultsWhenKeyMissing — empty
	// is treated identically to unset by friendlyHome(), and the
	// runtime auto-restores at test end.
	t.Setenv("FRIDAY_LAUNCHER_HOME", "")

	wantDefault := filepath.Join(tmpHome, ".friday", "local", "nats")

	storeDir, source := resolveJetStreamStoreDir()
	if storeDir != wantDefault {
		t.Errorf("storeDir = %q, want %q", storeDir, wantDefault)
	}
	if source != "default" {
		t.Errorf("source = %q, want default", source)
	}

	specs := supervisedProcesses("/tmp/bin")
	nats := findNatsSpec(t, specs)
	assertSdArg(t, nats.args, wantDefault)
}

// TestSupervisedProcesses_NatsServerHonorsLauncherHomeOverride pins
// that the default (when the .env key is absent) follows
// FRIDAY_LAUNCHER_HOME. Operators / CI runs sometimes rebase the
// whole launcher home to a non-standard location; the JetStream
// store must follow them rather than splattering data back into
// ~/.friday/local.
func TestSupervisedProcesses_NatsServerHonorsLauncherHomeOverride(t *testing.T) {
	tmpHome := t.TempDir()
	customHome := filepath.Join(tmpHome, "custom-home")
	if err := os.MkdirAll(customHome, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FRIDAY_LAUNCHER_HOME", customHome)
	// No .env at customHome → resolveJetStreamStoreDir must use the
	// computed fallback.

	wantDefault := filepath.Join(customHome, "nats")

	storeDir, source := resolveJetStreamStoreDir()
	if storeDir != wantDefault {
		t.Errorf("storeDir = %q, want %q", storeDir, wantDefault)
	}
	if source != "default" {
		t.Errorf("source = %q, want default", source)
	}

	specs := supervisedProcesses("/tmp/bin")
	nats := findNatsSpec(t, specs)
	assertSdArg(t, nats.args, wantDefault)
}

// findNatsSpec returns a pointer to the nats-server processSpec, failing
// the test if it's missing. Centralized so tests don't repeat the loop.
func findNatsSpec(t *testing.T, specs []processSpec) *processSpec {
	t.Helper()
	for i := range specs {
		if specs[i].name == "nats-server" {
			return &specs[i]
		}
	}
	t.Fatalf("service \"nats-server\" missing from supervisedProcesses")
	return nil
}

// assertSdArg asserts the args slice contains `-sd <wantValue>` AND
// that `-sd` sits between `--jetstream` and `--http_port`. The
// position assertion guards against a refactor that appends -sd at
// the end (which works at runtime but breaks the documented contract
// in the v6 plan).
func assertSdArg(t *testing.T, args []string, wantValue string) {
	t.Helper()
	idx := slices.Index(args, "-sd")
	if idx == -1 {
		t.Fatalf("args missing -sd flag: %v", args)
	}
	if idx+1 >= len(args) {
		t.Fatalf("args end with -sd and no value: %v", args)
	}
	if args[idx+1] != wantValue {
		t.Errorf("-sd value = %q, want %q (args=%v)",
			args[idx+1], wantValue, args)
	}
	jsIdx := slices.Index(args, "--jetstream")
	httpIdx := slices.Index(args, "--http_port")
	if jsIdx == -1 || httpIdx == -1 {
		t.Fatalf("args missing --jetstream or --http_port: %v", args)
	}
	if jsIdx >= idx || idx >= httpIdx {
		t.Errorf("-sd not positioned between --jetstream and --http_port: jetstream@%d sd@%d http_port@%d (args=%v)",
			jsIdx, idx, httpIdx, args)
	}
	// Defense in depth: the joined string check mirrors how
	// existing tests in project_env_test.go assert flag presence.
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-sd "+wantValue) {
		t.Errorf("joined args missing %q\ngot: %s", "-sd "+wantValue, joined)
	}
}
