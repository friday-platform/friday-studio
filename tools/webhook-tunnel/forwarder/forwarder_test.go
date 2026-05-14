package forwarder

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestForwardHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method: want POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/workspaces/ws-1/signals/sig-1" {
			t.Errorf("path: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		payload, _ := body["payload"].(map[string]any)
		if payload["foo"] != "bar" {
			t.Errorf("payload missing: %v", payload)
		}
		_, _ = w.Write([]byte(`{"sessionId":"sess-123"}`))
	}))
	defer srv.Close()

	f, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	sid, err := f.Forward("ws-1", "sig-1", map[string]any{"foo": "bar"})
	if err != nil {
		t.Fatalf("forward: %v", err)
	}
	if sid != "sess-123" {
		t.Errorf("sessionId: want sess-123, got %q", sid)
	}
}

func TestForwardNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`workspace not found`))
	}))
	defer srv.Close()
	f, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = f.Forward("ws", "sig", nil)
	if err == nil {
		t.Fatalf("expected error on 5xx response")
	}
	if !strings.Contains(err.Error(), "atlasd 500") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestProxyPathRewrite(t *testing.T) {
	var capturedPath string
	var capturedQuery string
	var capturedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedQuery = r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		capturedBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r := chi.NewRouter()
	r.Handle("/platform/{provider}", f.ProxyHandler())
	r.Handle("/platform/{provider}/*", f.ProxyHandler())
	clientSrv := httptest.NewServer(r)
	defer clientSrv.Close()

	// 1. With suffix and query.
	resp, err := http.Post(
		clientSrv.URL+"/platform/telegram/abc-token?hub.challenge=42",
		"application/json", strings.NewReader(`{"ping":1}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_ = resp.Body.Close()
	if capturedPath != "/signals/telegram/abc-token" {
		t.Errorf("path: want /signals/telegram/abc-token, got %s", capturedPath)
	}
	if capturedQuery != "hub.challenge=42" {
		t.Errorf("query: want hub.challenge=42, got %s", capturedQuery)
	}
	if capturedBody != `{"ping":1}` {
		t.Errorf("body: want {\"ping\":1}, got %s", capturedBody)
	}

	// 2. Without suffix.
	resp, err = http.Post(clientSrv.URL+"/platform/slack", "application/json", strings.NewReader(``))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_ = resp.Body.Close()
	if capturedPath != "/signals/slack" {
		t.Errorf("path: want /signals/slack, got %s", capturedPath)
	}
}

// TestProxyStripsHopByHop verifies that httputil.ReverseProxy strips
// RFC 7230 hop-by-hop headers — the bug the TS implementation has.
func TestProxyStripsHopByHop(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer srv.Close()

	f, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r := chi.NewRouter()
	r.Handle("/platform/{provider}", f.ProxyHandler())
	clientSrv := httptest.NewServer(r)
	defer clientSrv.Close()

	req, _ := http.NewRequest(http.MethodPost, clientSrv.URL+"/platform/raw", strings.NewReader(""))
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Keep-Alive", "timeout=5")
	req.Header.Set("X-Custom", "preserved")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	_ = resp.Body.Close()

	if got.Get("Connection") != "" {
		t.Errorf("Connection header should be stripped, got %q", got.Get("Connection"))
	}
	if got.Get("Keep-Alive") != "" {
		t.Errorf("Keep-Alive header should be stripped, got %q", got.Get("Keep-Alive"))
	}
	if got.Get("X-Custom") != "preserved" {
		t.Errorf("X-Custom should be preserved, got %q", got.Get("X-Custom"))
	}
}

// TestForwardTrustsPrivateCA verifies that when New() is given a CA
// file, the forwarder can reach an HTTPS atlasd whose cert chains to
// that CA — the path that breaks without FRIDAY_TLS_CA plumbing.
func TestForwardTrustsPrivateCA(t *testing.T) {
	// Mint a self-signed CA + leaf for 127.0.0.1.
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	caCert, _ := x509.ParseCertificate(caDER)

	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafTpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	leafDER, _ := x509.CreateCertificate(rand.Reader, leafTpl, caCert, &leafKey.PublicKey, caKey)

	// Persist the CA in PEM so New() can read it via path.
	tmp := t.TempDir()
	caPath := filepath.Join(tmp, "ca.crt")
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	if err := os.WriteFile(caPath, caPEM, 0o600); err != nil {
		t.Fatalf("write ca: %v", err)
	}

	// Stand up an httptest TLS server presenting the leaf, then validate
	// that a forwarder configured WITHOUT the CA fails and one WITH the
	// CA succeeds — exactly the divergence the s2s rollout introduced.
	tlsCert := tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"sessionId":"ok"}`))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{tlsCert}}
	srv.StartTLS()
	defer srv.Close()

	// Without CA: must error with an x509 / unknown-authority message.
	noCA, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New no-ca: %v", err)
	}
	if _, err := noCA.Forward("ws", "sig", nil); err == nil {
		t.Fatalf("expected TLS verification error without CA")
	}

	// With CA: must succeed.
	withCA, err := New(srv.URL, caPath)
	if err != nil {
		t.Fatalf("New with-ca: %v", err)
	}
	sid, err := withCA.Forward("ws", "sig", nil)
	if err != nil {
		t.Fatalf("forward with CA: %v", err)
	}
	if sid != "ok" {
		t.Errorf("sessionId: want ok, got %q", sid)
	}
}

// TestNewRejectsInvalidCA covers the loud-failure case: caller passes
// a path that isn't a valid PEM. We'd rather fail at startup than
// silently degrade to "no extra trust" and then mysteriously fail at
// every forward call.
func TestNewRejectsInvalidCA(t *testing.T) {
	tmp := t.TempDir()
	bogus := filepath.Join(tmp, "bogus.crt")
	_ = os.WriteFile(bogus, []byte("not a certificate"), 0o600)
	if _, err := New("http://localhost:8080", bogus); err == nil {
		t.Fatalf("expected error for invalid PEM, got nil")
	}
	if _, err := New("http://localhost:8080", filepath.Join(tmp, "missing.crt")); err == nil {
		t.Fatalf("expected error for missing CA file, got nil")
	}
}
