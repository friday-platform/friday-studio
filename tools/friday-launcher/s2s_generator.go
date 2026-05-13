// Service-to-service TLS material.
//
// The PR #243 split between browser-trusted TLS (Let's Encrypt for
// local.hellofriday.ai, refreshed from CDN by tls_renewer.go) and
// service-to-service TLS (private CA + leaf, used by atlasd + webhook-
// tunnel listeners and trusted by their callers via DENO_CERT /
// NODE_EXTRA_CA_CERTS) leaves the s2s side without a producer in the
// installed flow — scripts/setup-tls.sh handles it for dev, but
// production installs had no s2s certs at all and services fell back to
// plain HTTP on loopback.
//
// This file is the launcher-side producer. On boot, before any service
// is spawned, the launcher ensures the s2s pair exists and is valid; if
// not, it generates a fresh private CA + leaf signed by the CA with a
// 5-year validity window (rotation past 5 years is the operator's
// problem — re-running the launcher with the files removed regenerates).
//
// Path resolution mirrors the browser-cert side: each path honors an
// override env var first (FRIDAY_TLS_CERT / _KEY / _CA), then defaults
// to <friendlyHome()>/tls/. Operators using FRIDAY_LAUNCHER_HOME or
// pinning certs from somewhere else get full control; the default works
// without configuration.

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// s2sValidity is the lifetime stamped on both the CA and the leaf cert
// at generation time. Five years matches the user's stated requirement;
// long enough that a fresh install doesn't hit rotation for the life of
// most deployments, short enough that the cert eventually rotates if a
// machine stays on the same install indefinitely. When the leaf expires,
// the launcher's ensureS2sCerts re-generates the whole pair (cheap —
// generation is sub-second).
const s2sValidity = 5 * 365 * 24 * time.Hour

// s2sCertPath / s2sKeyPath / s2sCAPath resolve the on-disk paths for
// the service-to-service cert chain. Each honors the corresponding
// FRIDAY_TLS_* override env var first; without an override they default
// to <friendlyHome()>/tls/ with the same filenames scripts/setup-tls.sh
// produces in dev mode, so any code that already trusts that location
// (atlas-cli, atlasd, webhook-tunnel, vite SSR via DENO_CERT /
// NODE_EXTRA_CA_CERTS) keeps working unchanged.
func s2sCertPath() string {
	if v := os.Getenv("FRIDAY_TLS_CERT"); v != "" {
		return v
	}
	return filepath.Join(friendlyHome(), "tls", "s2s.crt")
}

func s2sKeyPath() string {
	if v := os.Getenv("FRIDAY_TLS_KEY"); v != "" {
		return v
	}
	return filepath.Join(friendlyHome(), "tls", "s2s.key")
}

func s2sCAPath() string {
	if v := os.Getenv("FRIDAY_TLS_CA"); v != "" {
		return v
	}
	return filepath.Join(friendlyHome(), "tls", "s2s-ca.crt")
}

// s2sCAKeyPath is the private CA key. Not exposed to child processes
// (they only need the CA cert, FRIDAY_TLS_CA) — the key stays on the
// launcher's filesystem so leaf re-issuance has the signing material.
// Default path lives next to the public CA cert; no override env var
// because nothing else should read it.
func s2sCAKeyPath() string {
	return filepath.Join(filepath.Dir(s2sCAPath()), "s2s-ca.key")
}

// ensureS2sCerts is the boot-time call. Synchronous, idempotent. If the
// existing pair is valid and unexpired the function returns immediately;
// if anything's missing or the leaf is past notAfter, it regenerates
// CA + leaf in lockstep (a new CA produces a leaf signed by it, which
// any process that's currently trusting the OLD CA will reject — so we
// always regenerate both together rather than re-signing with a stale
// CA). Returns an error only on filesystem / crypto failure; missing
// files are not an error, they're the "generate" trigger.
func ensureS2sCerts() error {
	if s2sCertsValid(time.Now()) {
		return nil
	}
	caCert, caKey, err := generateS2sCA()
	if err != nil {
		return fmt.Errorf("generate s2s CA: %w", err)
	}
	leafCert, leafKey, err := generateS2sLeaf(caCert, caKey)
	if err != nil {
		return fmt.Errorf("generate s2s leaf: %w", err)
	}

	caCertPEM := encodePEM("CERTIFICATE", caCert.Raw)
	caKeyDER, err := x509.MarshalECPrivateKey(caKey)
	if err != nil {
		return fmt.Errorf("marshal CA key: %w", err)
	}
	caKeyPEM := encodePEM("EC PRIVATE KEY", caKeyDER)

	leafCertPEM := encodePEM("CERTIFICATE", leafCert.Raw)
	leafKeyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return fmt.Errorf("marshal leaf key: %w", err)
	}
	leafKeyPEM := encodePEM("EC PRIVATE KEY", leafKeyDER)

	// Write in atomic-rename order: CA cert first (consumers may probe
	// for it to set up trust), then CA key (private), then leaf cert,
	// then leaf key. Each atomicWrite already does tmp+fsync+rename so a
	// crash mid-sequence leaves either old files or new files at each
	// path — never half-written. Trust mode bits: CA cert and leaf cert
	// are public (0644), both keys are 0600.
	for _, w := range []struct {
		path string
		data []byte
		mode os.FileMode
	}{
		{s2sCAPath(), caCertPEM, 0o644},
		{s2sCAKeyPath(), caKeyPEM, 0o600},
		{s2sCertPath(), leafCertPEM, 0o644},
		{s2sKeyPath(), leafKeyPEM, 0o600},
	} {
		if err := atomicWrite(w.path, w.data, w.mode); err != nil {
			return err
		}
	}
	return nil
}

// s2sCertsValid reports whether the full chain on disk is usable RIGHT
// NOW: all four files present, leaf parses, leaf is within its
// notBefore..notAfter window. We only check the leaf's validity, not
// the CA's — by construction the CA's validity covers the leaf's, and
// re-checking is overhead the boot path doesn't need.
func s2sCertsValid(now time.Time) bool {
	for _, p := range []string{s2sCAPath(), s2sCAKeyPath(), s2sCertPath(), s2sKeyPath()} {
		if _, err := os.Stat(p); err != nil {
			return false
		}
	}
	leaf, err := parseCert(s2sCertPath())
	if err != nil {
		return false
	}
	if isExpired(leaf, now) || notYetValid(leaf, now) {
		return false
	}
	return true
}

// generateS2sCA produces the private CA used to sign the s2s leaf.
// Subject CN is informational only ("Friday Studio Internal CA") —
// nothing trusts this by name, only by the CA cert hash plumbed into
// DENO_CERT / NODE_EXTRA_CA_CERTS.
func generateS2sCA() (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "Friday Studio Internal CA",
			Organization: []string{"Friday Studio"},
		},
		NotBefore:             now.Add(-1 * time.Hour),
		NotAfter:              now.Add(s2sValidity),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

// generateS2sLeaf signs the actual server certificate atlasd +
// webhook-tunnel present to clients. SAN covers localhost + loopback
// IPv4/IPv6 — the only addresses these services bind to in the
// installed flow. If anyone moves the listeners to a different
// hostname they'll need to add to this SAN list.
func generateS2sLeaf(ca *x509.Certificate, caKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "localhost",
			Organization: []string{"Friday Studio"},
		},
		DNSNames:    []string{"localhost"},
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		NotBefore:   now.Add(-1 * time.Hour),
		NotAfter:    now.Add(s2sValidity),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
			x509.ExtKeyUsageClientAuth,
		},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

func encodePEM(blockType string, der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
}
