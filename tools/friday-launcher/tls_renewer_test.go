package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// makeTestCert produces a self-signed cert with the given lifetime and
// returns (pemBytes, sha256hex). Lifetime is split equally around now:
// notBefore = now - half, notAfter = now + half, so a cert with
// lifetime=24h has 12h consumed and 12h remaining (≈ 50% of its life).
//
// `ageOverride` lets a test request a specific age. If set, notBefore =
// now - ageOverride and notAfter = now + (lifetime - ageOverride).
func makeTestCert(t *testing.T, lifetime time.Duration, ageOverride *time.Duration) ([]byte, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	now := time.Now()
	var notBefore, notAfter time.Time
	if ageOverride != nil {
		notBefore = now.Add(-*ageOverride)
		notAfter = notBefore.Add(lifetime)
	} else {
		half := lifetime / 2
		notBefore = now.Add(-half)
		notAfter = now.Add(half)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test.example"},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	sum := sha256.Sum256(pemBytes)
	return pemBytes, hex.EncodeToString(sum[:])
}

func TestPastTwoThirds(t *testing.T) {
	tests := []struct {
		name     string
		lifetime time.Duration
		age      time.Duration
		want     bool
	}{
		{"fresh (10%)", 30 * 24 * time.Hour, 3 * 24 * time.Hour, false},
		{"midlife (50%)", 30 * 24 * time.Hour, 15 * 24 * time.Hour, false},
		{"just under 2/3 (66%)", 30 * 24 * time.Hour, 19 * 24 * time.Hour, false},
		{"just over 2/3 (70%)", 30 * 24 * time.Hour, 21 * 24 * time.Hour, true},
		{"almost expired (95%)", 30 * 24 * time.Hour, 28*24*time.Hour + 12*time.Hour, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pemBytes, _ := makeTestCert(t, tt.lifetime, &tt.age)
			cert, err := parsePEMCert(pemBytes)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got := pastTwoThirds(cert, time.Now()); got != tt.want {
				t.Errorf("pastTwoThirds = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIsExpired(t *testing.T) {
	pastAge := 91 * 24 * time.Hour
	pemBytes, _ := makeTestCert(t, 90*24*time.Hour, &pastAge)
	cert, err := parsePEMCert(pemBytes)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !isExpired(cert, time.Now()) {
		t.Errorf("isExpired = false, want true for cert past notAfter")
	}
}

func TestNotYetValid(t *testing.T) {
	// age = -24h → notBefore is 24h in the future
	futureAge := -24 * time.Hour
	pemBytes, _ := makeTestCert(t, 90*24*time.Hour, &futureAge)
	cert, err := parsePEMCert(pemBytes)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !notYetValid(cert, time.Now()) {
		t.Errorf("notYetValid = false, want true for cert with future notBefore")
	}
}

func TestHasValidBrowserCert(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	tlsDir := filepath.Join(tmp, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Missing key → invalid.
	if hasValidBrowserCert() {
		t.Errorf("hasValidBrowserCert with no files = true, want false")
	}

	// Fresh cert + key present → valid.
	half := 12 * time.Hour
	pem24h, _ := makeTestCert(t, 24*time.Hour, &half)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), pem24h, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.key"), []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !hasValidBrowserCert() {
		t.Errorf("hasValidBrowserCert with fresh cert = false, want true")
	}

	// Expired cert → invalid.
	pastAge := 25 * time.Hour
	pemExpired, _ := makeTestCert(t, 24*time.Hour, &pastAge)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), pemExpired, 0o644); err != nil {
		t.Fatal(err)
	}
	if hasValidBrowserCert() {
		t.Errorf("hasValidBrowserCert with expired cert = true, want false")
	}
}

func TestNeedsRefresh(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	tlsDir := filepath.Join(tmp, "tls")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Missing cert → refresh.
	if !needsRefresh(time.Now()) {
		t.Errorf("needsRefresh with no cert = false, want true")
	}

	// Fresh cert (10% of life used) → no refresh.
	freshAge := 3 * 24 * time.Hour
	pemFresh, _ := makeTestCert(t, 30*24*time.Hour, &freshAge)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), pemFresh, 0o644); err != nil {
		t.Fatal(err)
	}
	if needsRefresh(time.Now()) {
		t.Errorf("needsRefresh with fresh cert = true, want false")
	}

	// Past 2/3 → refresh.
	oldAge := 25 * 24 * time.Hour
	pemOld, _ := makeTestCert(t, 30*24*time.Hour, &oldAge)
	if err := os.WriteFile(filepath.Join(tlsDir, "browser.crt"), pemOld, 0o644); err != nil {
		t.Fatal(err)
	}
	if !needsRefresh(time.Now()) {
		t.Errorf("needsRefresh past 2/3 = false, want true")
	}
}

func TestRefreshFromManifest_HappyPath(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	// Build the cert pair that the fake CDN will serve.
	half := 12 * time.Hour
	certPEM, certSha := makeTestCert(t, 90*24*time.Hour, &half)
	keyPEM := []byte("-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n")
	keySha := sha256SumHex(keyPEM)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			m := tlsManifest{
				Domain: "local.hellofriday.ai",
				Files: map[string]tlsManifestFile{
					"fullchain.pem": {URL: srvURL(r) + "/fullchain.pem", SHA256: certSha, Size: int64(len(certPEM))},
					"key.pem":       {URL: srvURL(r) + "/key.pem", SHA256: keySha, Size: int64(len(keyPEM))},
				},
			}
			_ = json.NewEncoder(w).Encode(m)
		case "/fullchain.pem":
			_, _ = w.Write(certPEM)
		case "/key.pem":
			_, _ = w.Write(keyPEM)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("FRIDAY_TLS_MANIFEST_URL", srv.URL+"/manifest.json")

	changed, err := refreshFromManifest(context.Background())
	if err != nil {
		t.Fatalf("refreshFromManifest: %v", err)
	}
	if !changed {
		t.Errorf("changed = false, want true (no prior files on disk)")
	}

	gotCert, err := os.ReadFile(filepath.Join(tmp, "tls", "browser.crt"))
	if err != nil {
		t.Fatalf("read cert: %v", err)
	}
	if string(gotCert) != string(certPEM) {
		t.Errorf("on-disk cert does not match manifest payload")
	}
	gotKey, err := os.ReadFile(filepath.Join(tmp, "tls", "browser.key"))
	if err != nil {
		t.Fatalf("read key: %v", err)
	}
	if string(gotKey) != string(keyPEM) {
		t.Errorf("on-disk key does not match manifest payload")
	}

	// Re-run: same sha on disk → no change (no download triggered).
	changed2, err := refreshFromManifest(context.Background())
	if err != nil {
		t.Fatalf("refreshFromManifest (idempotent): %v", err)
	}
	if changed2 {
		t.Errorf("second run changed = true, want false (idempotent)")
	}
}

func TestRefreshFromManifest_RejectsShaMismatch(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)

	half := 12 * time.Hour
	certPEM, _ := makeTestCert(t, 90*24*time.Hour, &half)
	keyPEM := []byte("k")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			// Wrong sha on purpose.
			m := tlsManifest{
				Files: map[string]tlsManifestFile{
					"fullchain.pem": {URL: srvURL(r) + "/fullchain.pem", SHA256: "deadbeef", Size: int64(len(certPEM))},
					"key.pem":       {URL: srvURL(r) + "/key.pem", SHA256: sha256SumHex(keyPEM), Size: int64(len(keyPEM))},
				},
			}
			_ = json.NewEncoder(w).Encode(m)
		case "/fullchain.pem":
			_, _ = w.Write(certPEM)
		case "/key.pem":
			_, _ = w.Write(keyPEM)
		}
	}))
	defer srv.Close()
	t.Setenv("FRIDAY_TLS_MANIFEST_URL", srv.URL+"/manifest.json")

	_, err := refreshFromManifest(context.Background())
	if err == nil {
		t.Fatalf("refreshFromManifest with bad sha = nil error, want error")
	}
	if _, statErr := os.Stat(filepath.Join(tmp, "tls", "browser.crt")); statErr == nil {
		t.Errorf("browser.crt written despite sha mismatch")
	}
}

func TestAtomicWrite_SetsMode(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "nested", "key.pem")
	if err := atomicWrite(p, []byte("k"), 0o600); err != nil {
		t.Fatalf("atomicWrite: %v", err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o, want 0600", perm)
	}
}

// ── helpers used only by these tests ─────────────────────────────────

// parsePEMCert is the same shape as parseCert but takes bytes directly,
// avoiding a tempfile round-trip in tests that already have the PEM in
// memory.
func parsePEMCert(data []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errCertParse
	}
	return x509.ParseCertificate(block.Bytes)
}

var errCertParse = &certParseError{}

type certParseError struct{}

func (*certParseError) Error() string { return "no CERTIFICATE block" }

func sha256SumHex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// srvURL reconstructs the scheme+host of the test server from a
// received request. httptest.Server.URL would also work but isn't
// in scope inside the handler.
func srvURL(r *http.Request) string {
	return "http://" + r.Host
}
