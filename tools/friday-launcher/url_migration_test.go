package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMigrateStaleURLSchemes_RewritesEveryStaleHTTPKey covers the
// canonical case the user reported: every URL knob the Tauri installer
// wrote with http:// gets flipped to https:// once s2s certs are valid.
//
// The fixture is GENERATED from staleHTTPSchemeKeys so adding a new key
// to that slice automatically grows the assertion — keeps the test
// and the production constant in lockstep without a one-off update on
// every addition. Previous form hardcoded "want=4" and missed any
// future key.
func TestMigrateStaleURLSchemes_RewritesEveryStaleHTTPKey(t *testing.T) {
	if len(staleHTTPSchemeKeys) == 0 {
		t.Fatal("staleHTTPSchemeKeys is empty — wiring lost?")
	}

	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	// Each migrated key gets a distinct loopback port so a mix-up in
	// the migration (e.g. accidentally rewriting one key's value into
	// another) shows up as a concrete byte mismatch.
	envPath := filepath.Join(tmp, ".env")
	var lines []string
	lines = append(lines, "FRIDAY_ENV=dev")
	for i, key := range staleHTTPSchemeKeys {
		lines = append(lines, fmt.Sprintf("%s=http://localhost:%d", key, 10000+i))
	}
	lines = append(lines, "FRIDAY_JETSTREAM_STORE_DIR=/some/path")
	original := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != len(staleHTTPSchemeKeys) {
		t.Errorf("migrated = %d, want %d (len(staleHTTPSchemeKeys))", got, len(staleHTTPSchemeKeys))
	}

	out, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	for i, key := range staleHTTPSchemeKeys {
		want := fmt.Sprintf("%s=https://localhost:%d", key, 10000+i)
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

// TestMigrateStaleURLSchemes_PreservesStructure_CRLF pins .env file
// structure across a migration: comments, blank lines, and CRLF line
// endings must survive byte-for-byte where they aren't being
// rewritten. Friday Studio ships on Windows where operators' editors
// (Notepad, VS Code default) write CRLF — a regression that flattens
// CRLF to LF would silently corrupt every operator's .env on the
// next launcher boot.
func TestMigrateStaleURLSchemes_PreservesStructure_CRLF(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	envPath := filepath.Join(tmp, ".env")
	// Fixture includes:
	//   - leading comment (#)
	//   - blank line
	//   - migrated key (FRIDAYD_URL) with CRLF
	//   - non-migrated key with CRLF
	//   - inline comment-ish line
	//   - trailing CRLF
	// Cases the migration must NOT touch: comments, blank lines, the
	// non-migrated FRIDAY_ENV key.
	original := "# Friday Studio config\r\n" +
		"\r\n" +
		"FRIDAY_ENV=dev\r\n" +
		"FRIDAYD_URL=http://localhost:18080\r\n" +
		"# trailing comment\r\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != 1 {
		t.Fatalf("migrated = %d, want 1 (only FRIDAYD_URL is on the list)", got)
	}

	out, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "# Friday Studio config\r\n" +
		"\r\n" +
		"FRIDAY_ENV=dev\r\n" +
		"FRIDAYD_URL=https://localhost:18080\r\n" +
		"# trailing comment\r\n"
	if string(out) != want {
		t.Errorf(".env structure not preserved\n"+
			"want=%q\n got=%q", want, string(out))
	}
}

// TestMigrateStaleURLSchemes_PreservesStructure_LF mirrors the CRLF
// test for the canonical Unix case. Captures any drift between the
// two line-ending styles separately rather than relying on a
// platform-detection branch we'd otherwise have to add.
func TestMigrateStaleURLSchemes_PreservesStructure_LF(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	writeValidS2sCerts(t, tmp)

	envPath := filepath.Join(tmp, ".env")
	original := "# Friday Studio config\n" +
		"\n" +
		"FRIDAY_ENV=dev\n" +
		"FRIDAYD_URL=http://localhost:18080\n" +
		"# trailing comment\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := migrateStaleURLSchemes(); err != nil {
		t.Fatal(err)
	}

	out, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "# Friday Studio config\n" +
		"\n" +
		"FRIDAY_ENV=dev\n" +
		"FRIDAYD_URL=https://localhost:18080\n" +
		"# trailing comment\n"
	if string(out) != want {
		t.Errorf(".env LF structure not preserved\nwant=%q\n got=%q", want, string(out))
	}
}

// TestMigrateStaleURLSchemes_TLSOff_DowngradesLoopback is the other
// half of the bidirectional contract. If the launcher boots with
// no valid s2s certs (first install, manual removal, cert expiry
// without renewer success), a previously-migrated `.env` containing
// `https://localhost:...` URLs must be flipped BACK to `http://`.
// Otherwise every consumer reads `https://` and sends TLS to a plain-
// HTTP listener — same failure mode the upgrade direction prevents,
// in reverse.
//
// Critical: the downgrade ONLY applies to loopback URLs. An operator-
// pinned `https://my-reverse-proxy.local:443` is their explicit
// choice and must pass through.
func TestMigrateStaleURLSchemes_TLSOff_DowngradesLoopback(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	// No s2s certs planted → s2sCertsValid()==false.

	envPath := filepath.Join(tmp, ".env")
	original := "FRIDAYD_URL=https://localhost:18080\n" +
		"EXTERNAL_DAEMON_URL=https://127.0.0.1:18080\n" +
		"LINK_SERVICE_URL=https://my-reverse-proxy.local:443\n" +
		"OTHER_KEY=https://localhost:9999\n"
	if err := os.WriteFile(envPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := migrateStaleURLSchemes()
	if err != nil {
		t.Fatalf("migrateStaleURLSchemes: %v", err)
	}
	if got != 2 {
		t.Errorf("downgraded = %d, want 2 (only FRIDAYD_URL + EXTERNAL_DAEMON_URL — the loopback launcher-managed pair)", got)
	}

	out, _ := os.ReadFile(envPath)
	want := "FRIDAYD_URL=http://localhost:18080\n" +
		"EXTERNAL_DAEMON_URL=http://127.0.0.1:18080\n" +
		"LINK_SERVICE_URL=https://my-reverse-proxy.local:443\n" +
		"OTHER_KEY=https://localhost:9999\n"
	if string(out) != want {
		t.Errorf("downgrade output mismatch\nwant=%q\n got=%q", want, string(out))
	}
}
