package main

import (
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestEnsureS2sCerts_FirstRunGeneratesPair(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("ensureS2sCerts: %v", err)
	}

	for _, name := range []string{"s2s-ca.crt", "s2s-ca.key", "s2s.crt", "s2s.key"} {
		p := filepath.Join(tmp, "tls", name)
		st, err := os.Stat(p)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		var wantMode os.FileMode
		if name == "s2s-ca.key" || name == "s2s.key" {
			wantMode = 0o600
		} else {
			wantMode = 0o644
		}
		if perm := st.Mode().Perm(); perm != wantMode {
			t.Errorf("%s mode = %o, want %o", name, perm, wantMode)
		}
	}
}

func TestEnsureS2sCerts_LeafSignedByCA(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("ensureS2sCerts: %v", err)
	}

	ca, err := parseCert(filepath.Join(tmp, "tls", "s2s-ca.crt"))
	if err != nil {
		t.Fatalf("parse CA: %v", err)
	}
	leaf, err := parseCert(filepath.Join(tmp, "tls", "s2s.crt"))
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}

	pool := x509.NewCertPool()
	pool.AddCert(ca)
	opts := x509.VerifyOptions{
		Roots:       pool,
		CurrentTime: time.Now(),
		// Server auth is the use we actually exercise (atlasd /
		// webhook-tunnel as servers). Client auth is included in the
		// leaf cert's EKU but not asserted here — server-auth is the
		// load-bearing one for the s2s mesh.
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if _, err := leaf.Verify(opts); err != nil {
		t.Errorf("leaf does not verify against CA: %v", err)
	}
}

func TestEnsureS2sCerts_FiveYearValidity(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("ensureS2sCerts: %v", err)
	}

	leaf, err := parseCert(filepath.Join(tmp, "tls", "s2s.crt"))
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	lifetime := leaf.NotAfter.Sub(leaf.NotBefore)
	// Allow slop: the impl uses now-1h..now+5y, so the *issued*
	// lifetime is slightly over 5y. Lower bound: 5y - 1d (give the
	// test some flex against leap-year / clock skew). Upper: 5y + 1d.
	fiveYears := 5 * 365 * 24 * time.Hour
	day := 24 * time.Hour
	if lifetime < fiveYears-day || lifetime > fiveYears+day+time.Hour {
		t.Errorf("lifetime = %v, want ≈ %v", lifetime, fiveYears)
	}
}

func TestEnsureS2sCerts_LeafSAN(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("ensureS2sCerts: %v", err)
	}

	leaf, err := parseCert(filepath.Join(tmp, "tls", "s2s.crt"))
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	if !slices.Contains(leaf.DNSNames, "localhost") {
		t.Errorf("DNSNames missing localhost: %v", leaf.DNSNames)
	}
	hasV4, hasV6 := false, false
	for _, ip := range leaf.IPAddresses {
		if ip.Equal(net.IPv4(127, 0, 0, 1)) {
			hasV4 = true
		}
		if ip.Equal(net.IPv6loopback) {
			hasV6 = true
		}
	}
	if !hasV4 || !hasV6 {
		t.Errorf("IPAddresses missing loopback: %v", leaf.IPAddresses)
	}
}

func TestEnsureS2sCerts_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("first run: %v", err)
	}
	certBefore, _ := os.ReadFile(filepath.Join(tmp, "tls", "s2s.crt"))
	caBefore, _ := os.ReadFile(filepath.Join(tmp, "tls", "s2s-ca.crt"))

	// Second run: cert is fresh, must not regenerate.
	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("second run: %v", err)
	}
	certAfter, _ := os.ReadFile(filepath.Join(tmp, "tls", "s2s.crt"))
	caAfter, _ := os.ReadFile(filepath.Join(tmp, "tls", "s2s-ca.crt"))

	if string(certBefore) != string(certAfter) {
		t.Errorf("leaf cert regenerated on idempotent re-run")
	}
	if string(caBefore) != string(caAfter) {
		t.Errorf("CA cert regenerated on idempotent re-run")
	}
}

func TestEnsureS2sCerts_RegeneratesWhenLeafMissing(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("first run: %v", err)
	}
	// Remove just the leaf cert; re-run should regenerate everything
	// (CA + leaf in lockstep — see comment in ensureS2sCerts).
	if err := os.Remove(filepath.Join(tmp, "tls", "s2s.crt")); err != nil {
		t.Fatal(err)
	}
	caBefore, _ := os.ReadFile(filepath.Join(tmp, "tls", "s2s-ca.crt"))

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("re-run: %v", err)
	}
	caAfter, _ := os.ReadFile(filepath.Join(tmp, "tls", "s2s-ca.crt"))
	if string(caBefore) == string(caAfter) {
		t.Errorf("CA unchanged after leaf removal; expected lockstep regeneration")
	}
}

func TestS2sPaths_HonorEnvOverrides(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("FRIDAY_TLS_CERT", "/custom/s2s.crt")
	t.Setenv("FRIDAY_TLS_KEY", "/custom/s2s.key")
	t.Setenv("FRIDAY_TLS_CA", "/custom/s2s-ca.crt")

	if got := s2sCertPath(); got != "/custom/s2s.crt" {
		t.Errorf("s2sCertPath = %q, want /custom/s2s.crt", got)
	}
	if got := s2sKeyPath(); got != "/custom/s2s.key" {
		t.Errorf("s2sKeyPath = %q, want /custom/s2s.key", got)
	}
	if got := s2sCAPath(); got != "/custom/s2s-ca.crt" {
		t.Errorf("s2sCAPath = %q, want /custom/s2s-ca.crt", got)
	}
}

func TestBrowserTlsPaths_HonorEnvOverrides(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("FRIDAY_BROWSER_TLS_CERT", "/custom/browser.crt")
	t.Setenv("FRIDAY_BROWSER_TLS_KEY", "/custom/browser.key")

	if got := tlsCertPath(); got != "/custom/browser.crt" {
		t.Errorf("tlsCertPath = %q, want /custom/browser.crt", got)
	}
	if got := tlsKeyPath(); got != "/custom/browser.key" {
		t.Errorf("tlsKeyPath = %q, want /custom/browser.key", got)
	}
}

// Sanity: PEM blocks must round-trip through the encodePEM helper into
// real ASN.1 we can re-parse.
func TestEncodePEM_RoundTrips(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	if err := ensureS2sCerts(); err != nil {
		t.Fatalf("ensureS2sCerts: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(tmp, "tls", "s2s-ca.key"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "EC PRIVATE KEY" {
		t.Fatalf("expected EC PRIVATE KEY block, got %v", block)
	}
	if _, err := x509.ParseECPrivateKey(block.Bytes); err != nil {
		t.Errorf("ParseECPrivateKey: %v", err)
	}
}
