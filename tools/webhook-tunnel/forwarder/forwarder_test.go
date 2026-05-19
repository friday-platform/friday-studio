package forwarder

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
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

// TestWebhookProxyByteForByte verifies the load-bearing property of the
// tunnel: a request that arrives on /hook/raw/{ws}/{sig} reaches atlasd
// with body bytes and headers preserved verbatim — only the URL host
// + path change. This is what makes downstream HMAC verification work.
func TestWebhookProxyByteForByte(t *testing.T) {
	var (
		seenPath    string
		seenMethod  string
		seenBody    []byte
		seenHeaders http.Header
	)
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenMethod = r.Method
		seenBody, _ = io.ReadAll(r.Body)
		seenHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"accepted","correlationId":"corr-1"}`))
	}))
	defer atlasd.Close()

	f, err := New(atlasd.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r := chi.NewRouter()
	r.Post("/hook/{provider}/{workspaceId}/{signalId}", f.WebhookProxyHandler().ServeHTTP)
	tunnel := httptest.NewServer(r)
	defer tunnel.Close()

	// Replay a realistic GitHub-style POST: signed body + standard webhook headers.
	body := []byte(`{"action":"opened","repository":{"full_name":"acme/widgets"},"sender":{"login":"alice"}}`)
	req, _ := http.NewRequest(http.MethodPost,
		tunnel.URL+"/hook/raw/ws-light_papaya/sig-pr-opened",
		strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "72d3162e-cc78-11e3-81ab-4c9367dc0958")
	req.Header.Set("X-Hub-Signature-256", "sha256=abc123deadbeef")
	req.Header.Set("User-Agent", "GitHub-Hookshot/abc")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("status: want 202, got %d", resp.StatusCode)
	}
	if seenMethod != http.MethodPost {
		t.Errorf("method: want POST, got %s", seenMethod)
	}
	if seenPath != "/api/workspaces/ws-light_papaya/signals/sig-pr-opened" {
		t.Errorf("path: want /api/workspaces/ws-light_papaya/signals/sig-pr-opened, got %s", seenPath)
	}
	if !bytes.Equal(seenBody, body) {
		t.Errorf("body bytes mismatch:\n  want: %x\n  got:  %x", body, seenBody)
	}
	for _, h := range []string{
		"X-Github-Event", // Go canonicalizes "X-GitHub-Event"
		"X-Github-Delivery",
		"X-Hub-Signature-256",
		"User-Agent",
		"Content-Type",
	} {
		if seenHeaders.Get(h) == "" {
			t.Errorf("header %q lost in proxy", h)
		}
	}
	if seenHeaders.Get("X-Github-Event") != "pull_request" {
		t.Errorf("X-GitHub-Event value mutated: %q", seenHeaders.Get("X-Github-Event"))
	}
	if seenHeaders.Get("X-Hub-Signature-256") != "sha256=abc123deadbeef" {
		t.Errorf("X-Hub-Signature-256 value mutated: %q", seenHeaders.Get("X-Hub-Signature-256"))
	}
}

// TestWebhookProxyStripsHopByHop confirms the RFC 7230 hop-by-hop
// header stripping httputil.ReverseProxy gives us for free — the agent
// never sees Connection / Keep-Alive / etc.
func TestWebhookProxyStripsHopByHop(t *testing.T) {
	var got http.Header
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer atlasd.Close()

	f, err := New(atlasd.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r := chi.NewRouter()
	r.Post("/hook/{provider}/{workspaceId}/{signalId}", f.WebhookProxyHandler().ServeHTTP)
	tunnel := httptest.NewServer(r)
	defer tunnel.Close()

	req, _ := http.NewRequest(http.MethodPost,
		tunnel.URL+"/hook/raw/ws/sig", strings.NewReader(`{"k":1}`))
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Keep-Alive", "timeout=5")
	req.Header.Set("X-Custom", "preserved")
	resp, _ := http.DefaultClient.Do(req)
	_ = resp.Body.Close()

	if got.Get("Connection") != "" {
		t.Errorf("Connection should be stripped, got %q", got.Get("Connection"))
	}
	if got.Get("Keep-Alive") != "" {
		t.Errorf("Keep-Alive should be stripped, got %q", got.Get("Keep-Alive"))
	}
	if got.Get("X-Custom") != "preserved" {
		t.Errorf("X-Custom should be preserved, got %q", got.Get("X-Custom"))
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

// TestProxyTrustsPrivateCA verifies that when New() is given a CA
// file, the proxy can reach an HTTPS atlasd whose cert chains to
// that CA — the path that breaks without FRIDAY_TLS_CA plumbing.
func TestProxyTrustsPrivateCA(t *testing.T) {
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

	// Stand up a TLS server presenting the leaf; verify the proxy can
	// reach it WITH the CA but not without.
	tlsCert := tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{tlsCert}}
	srv.StartTLS()
	defer srv.Close()

	// Without CA: request reaches the proxy but the proxy fails TLS to atlasd.
	// httputil.ReverseProxy surfaces this as 502 Bad Gateway to the caller.
	noCA, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New no-ca: %v", err)
	}
	r := chi.NewRouter()
	r.Post("/hook/{provider}/{workspaceId}/{signalId}", noCA.WebhookProxyHandler().ServeHTTP)
	tunnelNoCA := httptest.NewServer(r)
	defer tunnelNoCA.Close()
	resp, _ := http.Post(tunnelNoCA.URL+"/hook/raw/ws/sig",
		"application/json", strings.NewReader(`{}`))
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("without CA: want 502, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// With CA: must succeed.
	withCA, err := New(srv.URL, caPath)
	if err != nil {
		t.Fatalf("New with-ca: %v", err)
	}
	r2 := chi.NewRouter()
	r2.Post("/hook/{provider}/{workspaceId}/{signalId}", withCA.WebhookProxyHandler().ServeHTTP)
	tunnelWithCA := httptest.NewServer(r2)
	defer tunnelWithCA.Close()
	resp, err = http.Post(tunnelWithCA.URL+"/hook/raw/ws/sig",
		"application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("with CA: want 202, got %d", resp.StatusCode)
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
