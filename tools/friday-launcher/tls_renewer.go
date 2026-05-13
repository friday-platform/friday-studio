// TLS browser-cert renewer.
//
// The cert pair at <friendlyHome()>/tls/browser.{crt,key} is issued by
// Let's Encrypt for `local.hellofriday.ai` (public DNS → 127.0.0.1)
// and rotates every ~90 days. The Tauri installer fetches them once at
// install time via apps/studio-installer/src-tauri/src/commands/download_tls.rs;
// this file is the long-running launcher's renewal counterpart.
//
// Trigger model: TTL-based, not filesystem-based. The cert self-describes
// its lifetime via notBefore / notAfter — once we're past 2/3 of that
// window, we hit download.fridayplatform.io's manifest, sha256-verify the
// new pair, atomically install it, and restart the playground so it
// re-reads the files.
//
// Why TTL polling instead of fsnotify: the cert source is our own CDN
// manifest, not an external rotator like certbot. fsnotify would solve a
// problem we don't have (someone-else-writes-our-files) while adding
// per-OS filesystem-notification quirks. TTL polling is bounded,
// predictable, and the cert itself tells us when to act.
//
// Failure handling: if a refresh fails (offline, manifest down, sha
// mismatch) we log and retry on the next tick (daily). The on-disk cert
// keeps serving until it actually expires; once it expires, tls-paths.ts
// (playground) returns null so the playground falls back to plain http
// on :15200 — the launcher's playgroundURL() likewise downgrades to
// http://localhost. The browser will fail to validate an expired cert
// regardless of what we do, so falling back to http is the only path
// that keeps Studio usable while the network heals.

package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Manifest URL is overridable for local testing; matches the Rust
// installer's FRIDAY_TLS_MANIFEST_URL convention.
const defaultTLSManifestURL = "https://download.fridayplatform.io/tls/manifest.json"

// tlsRenewInterval is the cadence between renewer ticks. Daily is
// frequent enough to catch the 2/3-lifetime trigger within a day of it
// firing (so we always rotate before the cert expires) and infrequent
// enough that a CDN/manifest outage doesn't burn cycles. Override via
// FRIDAY_TLS_RENEW_INTERVAL for tests; parsed as a Go duration string.
const tlsRenewInterval = 24 * time.Hour

// bootRefreshTimeout caps the launcher-startup synchronous refresh
// attempt so a slow / dead CDN doesn't delay the rest of the boot. If
// we run out of budget, fall through to async refresh — the playground
// will come up on whatever certs are on disk (possibly http if they're
// expired) and the background ticker will retry.
const bootRefreshTimeout = 5 * time.Second

// tlsManifest mirrors the JSON published at download.fridayplatform.io/tls/manifest.json.
// Only the fields we consume are decoded.
type tlsManifest struct {
	Domain    string                     `json:"domain"`
	NotAfter  string                     `json:"notAfter"`
	NotBefore string                     `json:"notBefore"`
	Files     map[string]tlsManifestFile `json:"files"`
}

type tlsManifestFile struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// manifest file name → on-disk file name under <friendlyHome()>/tls/.
// Single source of truth for the mapping. fullchain.pem is what TLS
// servers should present (leaf + intermediate); cert.pem is leaf-only
// and we deliberately don't use it.
var tlsFiles = []struct {
	manifestName string
	onDiskName   string
	mode         os.FileMode
}{
	{"fullchain.pem", "browser.crt", 0o644},
	{"key.pem", "browser.key", 0o600},
}

// tlsCertDir resolves to <friendlyHome()>/tls/. Single helper so the
// renewer, the validity check (project.go), and any future caller stay
// in lock-step on where browser certs live.
func tlsCertDir() string {
	return filepath.Join(friendlyHome(), "tls")
}

// tlsCertPath / tlsKeyPath resolve the browser-trusted cert pair the
// playground origin presents to Chrome. Each honors the corresponding
// FRIDAY_BROWSER_TLS_* env var first (symmetric with s2sCertPath); the
// default location is <friendlyHome()>/tls/browser.{crt,key} — the
// priority-2 resolution slot in tls-paths.ts. Honoring the env vars
// here keeps the renewer's write path and the playground's read path
// in lock-step even when the operator pins certs elsewhere.
func tlsCertPath() string {
	if v := os.Getenv("FRIDAY_BROWSER_TLS_CERT"); v != "" {
		return v
	}
	return filepath.Join(tlsCertDir(), "browser.crt")
}

func tlsKeyPath() string {
	if v := os.Getenv("FRIDAY_BROWSER_TLS_KEY"); v != "" {
		return v
	}
	return filepath.Join(tlsCertDir(), "browser.key")
}

func tlsManifestURL() string {
	if v := os.Getenv("FRIDAY_TLS_MANIFEST_URL"); v != "" {
		return v
	}
	return defaultTLSManifestURL
}

func tlsRenewIntervalValue() time.Duration {
	if v := os.Getenv("FRIDAY_TLS_RENEW_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return tlsRenewInterval
}

// parseCert reads a PEM file from disk and returns the first
// certificate block. Returns nil + error if the file is missing,
// unreadable, malformed, or contains no CERTIFICATE block.
func parseCert(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	for {
		block, rest := pem.Decode(data)
		if block == nil {
			break
		}
		if block.Type == "CERTIFICATE" {
			return x509.ParseCertificate(block.Bytes)
		}
		data = rest
	}
	return nil, fmt.Errorf("no CERTIFICATE block in %s", path)
}

// isExpired reports whether the cert is past its notAfter. Treated as a
// non-revoke-able trigger to drop TLS (the browser would reject the
// cert anyway, so serving it is worse than falling back to http).
func isExpired(cert *x509.Certificate, now time.Time) bool {
	return now.After(cert.NotAfter)
}

// notYetValid reports whether the cert's notBefore is in the future,
// which on a correct-clock machine means the cert is malformed. Clock
// skew on the user's machine is a likely cause — we treat this the
// same as "expired" (don't serve, refresh).
func notYetValid(cert *x509.Certificate, now time.Time) bool {
	return now.Before(cert.NotBefore)
}

// pastTwoThirds reports whether the cert has consumed more than 2/3 of
// its issued lifetime. Threshold borrowed from
// opentelemetry-collector/config/configtls — same idea, same math.
// For a 90-day LE cert that's day 60; we always have ~30 days of
// runway to retry on intermittent failures.
func pastTwoThirds(cert *x509.Certificate, now time.Time) bool {
	lifetime := cert.NotAfter.Sub(cert.NotBefore)
	if lifetime <= 0 {
		// Defensive: a malformed cert with notBefore >= notAfter has
		// no meaningful "2/3". Treat as needing immediate refresh so
		// the bad cert gets replaced.
		return true
	}
	age := now.Sub(cert.NotBefore)
	return age*3 > lifetime*2
}

// hasValidBrowserCert reports whether the on-disk cert pair exists and
// the cert is currently within its notBefore..notAfter window. Used by
// playgroundURL to decide between https://local.hellofriday.ai and
// http://localhost — the launcher's URL must match what the playground
// will actually serve, and tls-paths.ts applies the same expiry check
// on its side.
func hasValidBrowserCert() bool {
	if _, err := os.Stat(tlsKeyPath()); err != nil {
		return false
	}
	cert, err := parseCert(tlsCertPath())
	if err != nil {
		return false
	}
	now := time.Now()
	if isExpired(cert, now) || notYetValid(cert, now) {
		return false
	}
	return true
}

// needsRefresh reports whether the on-disk cert is missing, expired,
// not-yet-valid, or past 2/3 of its issued lifetime. The renewer uses
// this as the single gate for "should I hit the manifest".
//
// Returning true on missing means a fresh launcher (no install-time
// cert fetch, e.g. a source build of friday-launcher) gets a renewer-
// driven first-time fetch. Returning true on expired means a stale
// install picks up service on next launcher boot.
func needsRefresh(now time.Time) bool {
	cert, err := parseCert(tlsCertPath())
	if err != nil {
		// Missing or malformed → need a fetch. If the directory
		// hasn't been created yet either, the manifest fetch will
		// still write it.
		return true
	}
	if isExpired(cert, now) || notYetValid(cert, now) {
		return true
	}
	return pastTwoThirds(cert, now)
}

// atomicWrite mirrors apps/studio-installer/src-tauri/src/commands/download_tls.rs's
// atomic_write: write tmp, fsync, chmod, rename. Guarantees an external
// observer (the playground reading the cert files at startup) sees
// either the prior content or the full new content — never a torn key
// that would surface as a TLS handshake failure with no obvious cause.
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	_ = os.Remove(tmp) // stale tmp from a prior crash is fine to drop

	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("create tmp %s: %w", tmp, err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("write tmp %s: %w", tmp, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("fsync tmp %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close tmp %s: %w", tmp, err)
	}
	// chmod again post-write because some umasks strip the bits we
	// passed to OpenFile (notably 0o600 for the key under a 0o022
	// umask should still be 0o600, but be explicit).
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("chmod tmp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s → %s: %w", tmp, path, err)
	}
	return nil
}

// fetchTLSManifest pulls the JSON manifest and parses it. Times out at
// 10s — slower than that and the launcher's renewer is wasting its
// daily budget on a stuck connection.
func fetchTLSManifest(ctx context.Context, url string) (*tlsManifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifest %s: HTTP %d", url, resp.StatusCode)
	}
	var m tlsManifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, fmt.Errorf("manifest %s: parse: %w", url, err)
	}
	return &m, nil
}

// fetchAndVerify downloads a file, verifies its size + sha256 against
// the manifest entry, and returns the bytes. Bounded body size: we cap
// reads at 2x the manifest-declared size so a malicious / corrupt
// response can't OOM the launcher.
func fetchAndVerify(ctx context.Context, entry tlsManifestFile, label string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, entry.URL, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", label, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", label, resp.StatusCode)
	}
	maxRead := entry.Size * 2
	if maxRead < 1024 {
		maxRead = 1024
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRead))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", label, err)
	}
	if int64(len(body)) != entry.Size {
		return nil, fmt.Errorf("%s: size mismatch (got %d, manifest %d)", label, len(body), entry.Size)
	}
	sum := sha256.Sum256(body)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, entry.SHA256) {
		return nil, fmt.Errorf("%s: sha256 mismatch (got %s, manifest %s)", label, got, entry.SHA256)
	}
	return body, nil
}

// refreshFromManifest pulls the manifest and, if any file's sha256
// differs from what's on disk, downloads and atomic-writes the new
// pair. Returns (changed, error): changed is true only when files were
// actually replaced — the caller uses it to decide whether to restart
// the playground (no-op restarts are pointless and would interrupt
// active sessions for nothing).
func refreshFromManifest(ctx context.Context) (bool, error) {
	m, err := fetchTLSManifest(ctx, tlsManifestURL())
	if err != nil {
		return false, err
	}

	type pending struct {
		path string
		data []byte
		mode os.FileMode
	}
	var writes []pending

	for _, f := range tlsFiles {
		entry, ok := m.Files[f.manifestName]
		if !ok {
			return false, fmt.Errorf("manifest missing %s", f.manifestName)
		}
		onDisk := filepath.Join(tlsCertDir(), f.onDiskName)
		existing, _ := os.ReadFile(onDisk)
		if len(existing) > 0 {
			sum := sha256.Sum256(existing)
			if strings.EqualFold(hex.EncodeToString(sum[:]), entry.SHA256) {
				// Already matches — skip download.
				continue
			}
		}
		data, err := fetchAndVerify(ctx, entry, f.manifestName)
		if err != nil {
			return false, err
		}
		writes = append(writes, pending{path: onDisk, data: data, mode: f.mode})
	}

	if len(writes) == 0 {
		return false, nil
	}

	// Write all-or-nothing: stage to .tmp, then rename. We rename in
	// the order tlsFiles is declared (cert first, then key) — if a
	// crash happens between the two renames, the cert-without-key
	// state is briefly visible but tls-paths.ts requires both for a
	// valid pair and the playground will fall back to http rather
	// than half-load TLS.
	for _, w := range writes {
		if err := atomicWrite(w.path, w.data, w.mode); err != nil {
			return false, err
		}
	}
	return true, nil
}

// startTLSRenewer launches the renewer goroutine.
//
// Lifecycle:
//   - Ticker fires every tlsRenewIntervalValue() (default 24h).
//   - On each tick: parse on-disk cert, call needsRefresh. If yes,
//     refreshFromManifest. On change, supervisor.RestartProcess("playground").
//   - The boot-time refresh attempt is NOT done here — see
//     maybeBootRefreshTLS, which main() calls synchronously before
//     starting the supervisor so a refresh that completes within
//     bootRefreshTimeout means the playground starts with TLS from go.
//
// Cancelled via ctx; production wires this to the launcher's main
// shutdown context so renewer goroutines don't outlive the launcher.
func startTLSRenewer(ctx context.Context, sup *Supervisor) {
	go func() {
		interval := tlsRenewIntervalValue()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				runRenewerTick(ctx, sup)
			}
		}
	}()
}

// runRenewerTick is the body of the daily loop, factored out so tests
// can call it directly without spinning up a ticker.
func runRenewerTick(ctx context.Context, sup *Supervisor) {
	if !needsRefresh(time.Now()) {
		return
	}
	changed, err := refreshFromManifest(ctx)
	if err != nil {
		log.Warn("tls: manifest refresh failed", "err", err)
		return
	}
	if !changed {
		// Cert was past 2/3 but the manifest still has the same
		// sha — the CDN hasn't rotated yet. Try again tomorrow.
		log.Info("tls: refresh checked, no new cert available")
		return
	}
	log.Info("tls: new cert installed, restarting playground")
	if sup == nil {
		return
	}
	if err := sup.RestartProcess("playground"); err != nil {
		log.Error("tls: restart playground after rotation", "err", err)
	}
}

// maybeBootRefreshTLS is the launcher-boot synchronous refresh attempt.
// Called BEFORE sup.runAndWatch starts the supervised processes so a
// fast manifest fetch means the playground reads the new cert files at
// the first chance.
//
// Bounded: returns within bootRefreshTimeout regardless of network
// conditions, so a stuck CDN cannot delay the launcher. On timeout or
// any failure, returns silently — the playground starts with whatever
// is on disk (possibly nothing, possibly expired) and the async
// renewer takes over.
func maybeBootRefreshTLS() {
	now := time.Now()
	if !needsRefresh(now) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), bootRefreshTimeout)
	defer cancel()
	changed, err := refreshFromManifest(ctx)
	if err != nil {
		log.Warn("tls: boot refresh failed (will retry async)", "err", err)
		return
	}
	if changed {
		log.Info("tls: boot refresh installed new cert")
	}
}
