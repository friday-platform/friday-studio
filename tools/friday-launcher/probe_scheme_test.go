package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestProbeScheme_NoCerts_AllHTTP pins the no-cert baseline: every
// supervised process gets a plain-http probe scheme. The readinessRunner
// then builds an http.Client with the default transport and skips
// per-runner TLS setup.
func TestProbeScheme_NoCerts_AllHTTP(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)

	for _, s := range supervisedProcesses("/tmp/dummy-bin") {
		if s.healthScheme != "http" {
			t.Errorf("%s: healthScheme = %q, want %q (no cert files present)",
				s.name, s.healthScheme, "http")
		}
	}
}

// TestProbeScheme_S2sOnly_FridayLinkTunnelHTTPS covers the production
// failure mode this work addresses: s2s certs valid, browser cert
// absent. friday / link / webhook-tunnel switch to https probes (matches
// the FRIDAY_TLS_CERT/_KEY gate each binary makes at boot). playground
// stays http because its OWN browser-trusted cert pair isn't there.
// nats-server stays http because its monitoring port is plain HTTP.
func TestProbeScheme_S2sOnly_FridayLinkTunnelHTTPS(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	writeValidS2sCerts(t, tmp)

	want := map[string]string{
		"nats-server":    "http",
		"friday":         "https",
		"link":           "https",
		"webhook-tunnel": "https",
		"playground":     "http",
	}
	for _, s := range supervisedProcesses("/tmp/dummy-bin") {
		if s.healthScheme != want[s.name] {
			t.Errorf("%s healthScheme = %q, want %q (s2s valid, browser absent)",
				s.name, s.healthScheme, want[s.name])
		}
	}
}

// TestProbeScheme_BothCerts_AllHTTPSExceptNats is the steady-state
// shape: both s2s and browser cert pairs valid. Every supervised
// service except nats-server probes via https.
func TestProbeScheme_BothCerts_AllHTTPSExceptNats(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	writeValidS2sCerts(t, tmp)
	writeValidBrowserCert(t, tmp)

	want := map[string]string{
		"nats-server":    "http",
		"friday":         "https",
		"link":           "https",
		"webhook-tunnel": "https",
		"playground":     "https",
	}
	for _, s := range supervisedProcesses("/tmp/dummy-bin") {
		if s.healthScheme != want[s.name] {
			t.Errorf("%s healthScheme = %q, want %q", s.name, s.healthScheme, want[s.name])
		}
	}
}

// TestProbeScheme_ExpiredS2sCert_FallsBackToHTTP is the expiry guard
// the user asked for: "present, readable, AND valid". An expired leaf
// must NOT count as TLS-on; the scheme has to fall back to http to
// match what the daemon would do at boot.
func TestProbeScheme_ExpiredS2sCert_FallsBackToHTTP(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	writeExpiredS2sLeaf(t, tmp)

	for _, s := range supervisedProcesses("/tmp/dummy-bin") {
		if s.healthScheme != "http" {
			t.Errorf("%s healthScheme = %q, want http (s2s leaf expired)",
				s.name, s.healthScheme)
		}
	}
}

// TestProbeScheme_AllSpecsHaveScheme guards against a future refactor
// that adds a service without wiring it into the per-name scheme
// switch. An empty scheme would propagate as the "http" default into
// newReadinessRunner — silent but technically correct; this test
// keeps the contract loud.
func TestProbeScheme_AllSpecsHaveScheme(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	for _, s := range supervisedProcesses("/tmp/dummy-bin") {
		if s.healthScheme != "http" && s.healthScheme != "https" {
			t.Errorf("%s healthScheme = %q; want http|https", s.name, s.healthScheme)
		}
	}
}

// writeValidS2sCerts plants a CA + leaf + key set at the s2s paths
// that ensureS2sCerts would have produced. We don't reuse the
// production generator because the expiry test below needs a
// deliberately-expired leaf; keeping the helpers independent keeps
// the assertions sharp.
func writeValidS2sCerts(t *testing.T, home string) {
	t.Helper()
	tlsDir := filepath.Join(home, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	half := 12 * time.Hour
	pem24h, _ := makeTestCert(t, 24*time.Hour, &half)
	files := map[string][]byte{
		"s2s-ca.crt": pem24h,
		"s2s-ca.key": []byte("ca-key"),
		"s2s.crt":    pem24h,
		"s2s.key":    []byte("leaf-key"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(tlsDir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// writeExpiredS2sLeaf plants the full s2s fileset but with a notAfter
// in the past. s2sCertsValid checks the leaf only — CA can stay fresh
// and still trip the expiry gate.
func writeExpiredS2sLeaf(t *testing.T, home string) {
	t.Helper()
	tlsDir := filepath.Join(home, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	half := 12 * time.Hour
	pemFresh, _ := makeTestCert(t, 24*time.Hour, &half)
	pastAge := 48 * time.Hour
	pemExpired, _ := makeTestCert(t, 24*time.Hour, &pastAge)
	files := map[string][]byte{
		"s2s-ca.crt": pemFresh,
		"s2s-ca.key": []byte("ca-key"),
		"s2s.crt":    pemExpired,
		"s2s.key":    []byte("leaf-key"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(tlsDir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// writeValidBrowserCert plants browser.crt + browser.key —
// hasValidBrowserCert only checks key existence + leaf validity.
func writeValidBrowserCert(t *testing.T, home string) {
	t.Helper()
	tlsDir := filepath.Join(home, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	half := 12 * time.Hour
	pem24h, _ := makeTestCert(t, 24*time.Hour, &half)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), pem24h, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.key"), []byte("browser-key"), 0o600); err != nil {
		t.Fatal(err)
	}
}
