// Cert-path .env writeback.
//
// The launcher is the cert authority — it generates the s2s CA + leaf
// (s2s_generator.go) and downloads / refreshes the browser-trusted LE
// cert (tls_renewer.go). The PATH each consumer reads them from is
// communicated through ~/.friday/local/.env, not through env vars
// injected at child-process spawn time.
//
// Why .env and not runtime injection: the launcher is supposed to be a
// convenient method to run Studio, not the only one. Anyone who runs
// `friday daemon start` directly — for debugging, for a custom shell,
// for CI — needs to see the same cert wiring without having to also
// run friday-launcher. .env is the existing channel the daemon, link,
// and the playground all read on startup; piggybacking on it keeps
// "with launcher" and "without launcher" execution paths in lockstep.
//
// Idempotency: ensureCertEnvFile writes each key only when it's
// missing from .env. A user who sets FRIDAY_TLS_CERT manually to a
// custom location keeps that value forever. The launcher's resolver
// (s2sCertPath / tlsCertPath / s2sCAPath) honors the same env vars,
// so generated certs land at the user-pinned location on the next
// rotation. .env stays the single source of truth.

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// envFilePath is the .env the launcher and every supervised service
// read from. Same path the Tauri installer's env_file.rs writes to.
func envFilePath() string {
	return filepath.Join(friendlyHome(), ".env")
}

// certEnvKeys is the set of cert-related env vars the launcher
// ensures are present in .env. Built lazily because each value depends
// on resolver calls (s2sCertPath etc.) which read FRIDAY_LAUNCHER_HOME
// and the env-var overrides — both of which can change between
// launcher boots.
func certEnvKeys() [][2]string {
	caPath := s2sCAPath()
	return [][2]string{
		{"FRIDAY_TLS_CERT", s2sCertPath()},
		{"FRIDAY_TLS_KEY", s2sKeyPath()},
		{"FRIDAY_TLS_CA", caPath},
		{"FRIDAY_BROWSER_TLS_CERT", tlsCertPath()},
		{"FRIDAY_BROWSER_TLS_KEY", tlsKeyPath()},
		// DENO_CERT + NODE_EXTRA_CA_CERTS point at the private CA so the
		// daemon (Deno's RootCertStore) and any Node-based proxy
		// (vite SSR, static-server's daemon proxy) trust the s2s leaf.
		// These were dev-only in scripts/setup-tls.sh; pinning them
		// here makes the installed flow self-sufficient.
		{"DENO_CERT", caPath},
		{"NODE_EXTRA_CA_CERTS", caPath},
	}
}

// ensureCertEnvFile reads .env, appends any missing cert-env keys with
// the launcher's resolved paths, and atomic-writes the file back. The
// .env file is created if absent. Existing values for any of the keys
// are preserved verbatim — operator overrides win.
//
// Returns the number of keys appended so the boot log can say "wrote
// 7 cert paths to .env" on first run and stay silent on warm boots.
func ensureCertEnvFile() (int, error) {
	path := envFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return 0, fmt.Errorf("mkdir env dir: %w", err)
	}

	existing, _ := os.ReadFile(path)
	present := map[string]struct{}{}
	for line := range strings.SplitSeq(string(existing), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if eq := strings.IndexByte(line, '='); eq > 0 {
			key := strings.TrimSpace(line[:eq])
			present[key] = struct{}{}
		}
	}

	var toAppend []string
	for _, kv := range certEnvKeys() {
		key, value := kv[0], kv[1]
		if _, ok := present[key]; ok {
			continue
		}
		toAppend = append(toAppend, key+"="+value)
	}
	if len(toAppend) == 0 {
		return 0, nil
	}

	out := string(existing)
	// Ensure separator between existing content and our appended lines
	// (and between our lines and any future trailing content). One
	// blank-line block keeps the file diff-readable when an operator
	// cracks .env open.
	if len(out) > 0 && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	if len(out) > 0 {
		out += "\n# launcher-managed cert paths (managed by friday-launcher; safe to edit)\n"
	}
	out += strings.Join(toAppend, "\n") + "\n"

	if err := atomicWrite(path, []byte(out), 0o644); err != nil {
		return 0, err
	}
	// No mirror into os.Setenv: the launcher's own boot path already
	// resolved cert paths from the existing env / defaults BEFORE
	// reaching this writeback (ensureS2sCerts ran first), and the
	// supervised services read .env directly via commonServiceEnv's
	// loadDotEnv call — which sees the file we just wrote. Touching
	// the launcher's process env here would leak across tests and
	// gain nothing in production.
	return len(toAppend), nil
}
