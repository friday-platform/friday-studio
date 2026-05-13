package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureCertEnvFile_FirstRunWritesAllKeys(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	added, err := ensureCertEnvFile()
	if err != nil {
		t.Fatalf("ensureCertEnvFile: %v", err)
	}
	if added != 7 {
		t.Errorf("added = %d, want 7 (5 cert + DENO_CERT + NODE_EXTRA_CA_CERTS)", added)
	}

	body, err := os.ReadFile(filepath.Join(tmp, ".env"))
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	want := []string{
		"FRIDAY_TLS_CERT=",
		"FRIDAY_TLS_KEY=",
		"FRIDAY_TLS_CA=",
		"FRIDAY_BROWSER_TLS_CERT=",
		"FRIDAY_BROWSER_TLS_KEY=",
		"DENO_CERT=",
		"NODE_EXTRA_CA_CERTS=",
	}
	for _, prefix := range want {
		if !strings.Contains(string(body), prefix) {
			t.Errorf(".env missing %q\nfull body:\n%s", prefix, body)
		}
	}
}

func TestEnsureCertEnvFile_PreservesUserOverrides(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	existing := "FRIDAY_TLS_CERT=/my/custom/cert.pem\nFRIDAY_PORT_PLAYGROUND=15200\n"
	if err := os.WriteFile(filepath.Join(tmp, ".env"), []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}

	added, err := ensureCertEnvFile()
	if err != nil {
		t.Fatalf("ensureCertEnvFile: %v", err)
	}
	// FRIDAY_TLS_CERT is already present so should NOT be re-added;
	// 6 keys remain to write.
	if added != 6 {
		t.Errorf("added = %d, want 6 (user already set FRIDAY_TLS_CERT)", added)
	}

	body, _ := os.ReadFile(filepath.Join(tmp, ".env"))
	// Original line untouched.
	if !strings.Contains(string(body), "FRIDAY_TLS_CERT=/my/custom/cert.pem") {
		t.Errorf("user-set FRIDAY_TLS_CERT overwritten\nbody:\n%s", body)
	}
	// And not duplicated.
	if strings.Count(string(body), "FRIDAY_TLS_CERT=") != 1 {
		t.Errorf("FRIDAY_TLS_CERT appears more than once\nbody:\n%s", body)
	}
}

func TestEnsureCertEnvFile_IdempotentOnReRun(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if _, err := ensureCertEnvFile(); err != nil {
		t.Fatalf("first run: %v", err)
	}
	body1, _ := os.ReadFile(filepath.Join(tmp, ".env"))

	added, err := ensureCertEnvFile()
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if added != 0 {
		t.Errorf("second run added = %d, want 0", added)
	}
	body2, _ := os.ReadFile(filepath.Join(tmp, ".env"))
	if string(body1) != string(body2) {
		t.Errorf(".env modified on idempotent re-run\n--- before ---\n%s\n--- after ---\n%s", body1, body2)
	}
}

func TestEnsureCertEnvFile_PicksUpEnvOverridesInResolver(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("FRIDAY_TLS_CERT", "/elsewhere/s2s.crt")

	// FRIDAY_TLS_CERT is set in env (not yet in .env). The resolver
	// returns the env value; ensureCertEnvFile writes that value to
	// .env so future invocations (without the env var set) still see
	// the same path.
	if _, err := ensureCertEnvFile(); err != nil {
		t.Fatalf("ensureCertEnvFile: %v", err)
	}
	body, _ := os.ReadFile(filepath.Join(tmp, ".env"))
	if !strings.Contains(string(body), "FRIDAY_TLS_CERT=/elsewhere/s2s.crt") {
		t.Errorf(".env did not capture env-override path\nbody:\n%s", body)
	}
}
