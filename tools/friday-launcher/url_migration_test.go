package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMigrateStaleURLSchemes_RewritesAllFourKeys covers the canonical
// case the user reported: every URL knob the Tauri installer wrote
// with http:// gets flipped to https:// once s2s certs are valid.
// The matching keys are exactly staleHTTPSchemeKeys — any future
// addition should grow this assertion list in lockstep.
func TestMigrateStaleURLSchemes_RewritesAllFourKeys(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	envPath := filepath.Join(tmp, ".env")
	original := strings.Join([]string{
		"FRIDAY_ENV=dev",
		"FRIDAYD_URL=http://localhost:18080",
		"EXTERNAL_DAEMON_URL=http://localhost:18080",
		"EXTERNAL_TUNNEL_URL=http://localhost:19090",
		"LINK_SERVICE_URL=http://localhost:13100",
		"FRIDAY_JETSTREAM_STORE_DIR=/some/path",
	}, "\n") + "\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != 4 {
		t.Errorf("migrated = %d, want 4 (FRIDAYD_URL + EXTERNAL_DAEMON_URL + EXTERNAL_TUNNEL_URL + LINK_SERVICE_URL)", got)
	}

	out, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"FRIDAYD_URL=https://localhost:18080",
		"EXTERNAL_DAEMON_URL=https://localhost:18080",
		"EXTERNAL_TUNNEL_URL=https://localhost:19090",
		"LINK_SERVICE_URL=https://localhost:13100",
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf(".env missing %q\nfull body:\n%s", want, out)
		}
	}
	// Sibling non-URL keys must pass through untouched.
	if !strings.Contains(string(out), "FRIDAY_ENV=dev") {
		t.Errorf("FRIDAY_ENV was rewritten / removed; full body:\n%s", out)
	}
}

// TestMigrateStaleURLSchemes_NoTLS_NoOp pins the safety condition: if
// s2s certs aren't valid, we MUST leave http:// values alone — a real
// http install would otherwise have its URLs flipped to a non-existent
// https listener and every request would fail with a TLS error.
func TestMigrateStaleURLSchemes_NoTLS_NoOp(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	// No s2s certs planted → s2sCertsValid() returns false.

	envPath := filepath.Join(tmp, ".env")
	original := "FRIDAYD_URL=http://localhost:18080\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != 0 {
		t.Errorf("migrated = %d, want 0 (s2s off → no-op)", got)
	}

	out, _ := os.ReadFile(envPath)
	if string(out) != original {
		t.Errorf(".env mutated despite s2s off:\nwant=%q\n got=%q", original, string(out))
	}
}

// TestMigrateStaleURLSchemes_LeavesExplicitHTTPS confirms we never
// downgrade. An operator who pinned https:// (e.g. they put a reverse
// proxy in front of the daemon) must keep that value.
func TestMigrateStaleURLSchemes_LeavesExplicitHTTPS(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	envPath := filepath.Join(tmp, ".env")
	original := "FRIDAYD_URL=https://my-reverse-proxy.local:443\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != 0 {
		t.Errorf("migrated = %d, want 0 (already https)", got)
	}
	out, _ := os.ReadFile(envPath)
	if string(out) != original {
		t.Errorf(".env mutated unexpectedly:\nwant=%q\n got=%q", original, string(out))
	}
}

// TestMigrateStaleURLSchemes_IdempotentOnSecondCall: the first call
// rewrites, the second sees https:// values and does nothing. Catches
// a regression where a future tweak makes the function rewrite on
// every boot.
func TestMigrateStaleURLSchemes_IdempotentOnSecondCall(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	envPath := filepath.Join(tmp, ".env")
	original := "FRIDAYD_URL=http://localhost:18080\nLINK_SERVICE_URL=http://localhost:13100\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	first, err := migrateStaleURLSchemes()
	if err != nil || first != 2 {
		t.Fatalf("first call: got (%d, %v), want (2, nil)", first, err)
	}
	second, err := migrateStaleURLSchemes()
	if err != nil || second != 0 {
		t.Errorf("second call: got (%d, %v), want (0, nil)", second, err)
	}
}

// TestMigrateStaleURLSchemes_IgnoresUnrelatedKeys: a key that
// COINCIDENTALLY starts with http:// (e.g. SOME_WEBHOOK_URL) must not
// be touched. We only migrate the named set so a stray third-party
// http:// value can't silently break by being flipped.
func TestMigrateStaleURLSchemes_IgnoresUnrelatedKeys(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	envPath := filepath.Join(tmp, ".env")
	original := strings.Join([]string{
		"SOME_THIRD_PARTY_URL=http://example.com/webhook",
		"FRIDAYD_URL=http://localhost:18080",
	}, "\n") + "\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != 1 {
		t.Errorf("migrated = %d, want 1 (only FRIDAYD_URL is on the list)", got)
	}
	out, _ := os.ReadFile(envPath)
	if !strings.Contains(string(out), "SOME_THIRD_PARTY_URL=http://example.com/webhook") {
		t.Errorf("unrelated key got rewritten:\n%s", out)
	}
}

// TestMigrateStaleURLSchemes_MissingEnvFile returns (0, nil) when
// .env doesn't exist yet. First-run installs have no .env; the
// launcher's own writeback runs AFTER cert generation, so we have to
// gracefully no-op until that file is in place.
func TestMigrateStaleURLSchemes_MissingEnvFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)
	// No .env on disk.

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Errorf("expected nil error on missing .env, got %v", err)
	}
	if got != 0 {
		t.Errorf("migrated = %d, want 0", got)
	}
}
