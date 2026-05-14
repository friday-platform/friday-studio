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
	"time"
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
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return 0, fmt.Errorf("mkdir env dir: %w", err)
	}

	// #nosec G304 -- envFilePath() resolves to ~/.friday/local/.env via
	// friendlyHome(); reading the operator's own launcher home is the
	// intended affordance, not a vulnerability.
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

// staleHTTPSchemeKeys lists the .env URL knobs the Tauri installer
// wrote with http:// before the s2s mesh existed. When the launcher
// mints s2s certs the supervised services flip to https on those
// ports, so the .env values become stale: any consumer that reads
// the env var literally (without re-deriving the scheme) ends up
// sending cleartext into a TLS listener.
//
// Each consumer ALSO does an http→https auto-upgrade as defense-in-
// depth (see packages/openapi-client/src/utils.ts, apps/atlasd/
// routes/link.ts, etc.), but the canonical fix is to migrate the
// .env once at the launcher level so:
//   - operators reading the file see the truth
//   - Python user-agents and other future consumers (which may not
//     run through our auto-upgrade helpers) get the right URL
//   - the in-tree friday-cli `cat .env` flow shows accurate state
var staleHTTPSchemeKeys = []string{
	"FRIDAYD_URL",
	"EXTERNAL_DAEMON_URL",
	"EXTERNAL_TUNNEL_URL",
	"LINK_SERVICE_URL",
}

// migrateStaleURLSchemes keeps the URL knobs in staleHTTPSchemeKeys in
// sync with the s2s cert state on disk. When TLS is on it rewrites
// `http://localhost:N` → `https://localhost:N` (the canonical fix for
// installs whose .env was written before the s2s mesh landed). When
// TLS is off — first install, manual cert removal, expired-and-not-
// renewed — it rewrites `https://localhost:N` BACK to `http://`, so a
// previous-migration leftover doesn't point consumers at a TLS
// listener the launcher won't bring up this boot.
//
// Both directions only touch loopback URLs (`localhost` / `127.0.0.1`)
// — an operator who pinned an explicit external URL like
// `https://my-reverse-proxy.local:443` knows their setup; we never
// downgrade it. Lines for absent keys are not added (this function
// only repairs).
//
// Returns the number of lines that flipped, so the boot log can stay
// silent on warm boots and surface a one-line audit on the first
// post-state-change launch.
func migrateStaleURLSchemes() (int, error) {
	path := envFilePath()
	// #nosec G304 -- launcher's own .env, see ensureCertEnvFile comment.
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("read env: %w", err)
	}
	tlsOn := s2sCertsValid(time.Now())
	keySet := make(map[string]struct{}, len(staleHTTPSchemeKeys))
	for _, k := range staleHTTPSchemeKeys {
		keySet[k] = struct{}{}
	}
	lines := strings.Split(string(raw), "\n")
	migrated := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		if _, ok := keySet[key]; !ok {
			continue
		}
		// Anything past "=" is the value verbatim — preserves trailing
		// whitespace, CRLF, and quoting. swapURLScheme owns the
		// loopback-only check + the direction logic.
		rewritten, changed := swapURLScheme(line[eq+1:], tlsOn)
		if !changed {
			continue
		}
		lines[i] = key + "=" + rewritten
		migrated++
	}
	if migrated == 0 {
		return 0, nil
	}
	if err := atomicWrite(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return 0, err
	}
	return migrated, nil
}

// swapURLScheme returns the value with its scheme aligned to TLS state,
// reporting whether anything changed. Only loopback URLs are eligible:
// any external host — an operator-pinned reverse proxy or cloud URL —
// passes through unchanged, regardless of TLS state.
//
// Direction:
//   - tlsOn  + value starts with `http://`  → upgrade to `https://`
//   - !tlsOn + value starts with `https://` → downgrade to `http://`
//   - everything else: pass-through.
//
// The value may carry a trailing `\r` (Windows CRLF) or other
// whitespace; we preserve it verbatim by slicing past the scheme only.
func swapURLScheme(value string, tlsOn bool) (string, bool) {
	const httpPrefix = "http://"
	const httpsPrefix = "https://"
	if tlsOn && strings.HasPrefix(value, httpPrefix) {
		rest := value[len(httpPrefix):]
		if !startsWithLoopbackHost(rest) {
			return value, false
		}
		return httpsPrefix + rest, true
	}
	if !tlsOn && strings.HasPrefix(value, httpsPrefix) {
		rest := value[len(httpsPrefix):]
		if !startsWithLoopbackHost(rest) {
			return value, false
		}
		return httpPrefix + rest, true
	}
	return value, false
}

// startsWithLoopbackHost reports whether the host portion of a URL
// remainder (post-scheme, e.g. `localhost:18080/path` or `127.0.0.1`)
// is a loopback. We intentionally don't do DNS resolution — `local.
// hellofriday.ai` resolves to 127.0.0.1 but isn't a loopback we want
// to flip; operators who put non-trivial hostnames in .env get
// pass-through behavior.
//
// Three loopback shapes are recognized:
//   - `localhost`         — hostname, optionally followed by `:port` or `/path`
//   - `127.0.0.1`         — IPv4 literal, same suffix rules
//   - `[::1]`             — IPv6 literal in bracketed URL form (RFC 3986)
//
// Bare unbracketed `::1` is not a valid URL host and won't reach this
// path; we don't try to handle it. Non-loopback IPv4s (`127.0.0.2`,
// `0.0.0.0`) and the IPv4-mapped IPv6 form (`[::ffff:127.0.0.1]`) are
// intentionally not flipped — the installer only writes the three
// canonical loopback strings above.
func startsWithLoopbackHost(rest string) bool {
	// IPv6 in URL form is always bracketed: `[::1]` or `[::1]:8080`.
	// Detect it first so the bracket-aware host extraction doesn't get
	// confused by the embedded colons.
	if strings.HasPrefix(rest, "[") {
		if end := strings.IndexByte(rest, ']'); end > 0 {
			return rest[1:end] == "::1"
		}
		return false
	}
	// Non-IPv6: host portion ends at the first '/' or ':' (colon-port).
	end := len(rest)
	for i := 0; i < len(rest); i++ {
		if rest[i] == '/' || rest[i] == ':' {
			end = i
			break
		}
	}
	host := rest[:end]
	return host == "localhost" || host == "127.0.0.1"
}
