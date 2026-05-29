package diagnostics

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// daemonStub configures the test daemon's responses. Zero value means
// 200 OK with a canned version body and a canned zip blob — the happy
// path that most tests want without ceremony.
type daemonStub struct {
	versionStatus int    // 0 → 200
	versionBody   string // empty → `{"version":"dev-abc1234"}`
	bundleStatus  int    // 0 → 200
	bundleBody    []byte // nil → []byte("STUB-BUNDLE-BYTES")
	bundleDelay   time.Duration
	// captureBundleQuery, when non-nil, receives the raw query string
	// of the /api/workspaces/bundle-all request. Lets a test pin the
	// mode=definition privacy brake. Fires on the server goroutine —
	// the caller is responsible for synchronizing its own read.
	captureBundleQuery func(rawQuery string)
}

// newDaemonStub spins up an httptest.Server that mimics the daemon's
// /api/version and /api/workspaces/bundle-all routes. Cleanup is the
// caller's job (defer srv.Close()) — t.Cleanup hides the URL lifetime
// from readers.
func newDaemonStub(t *testing.T, s daemonStub) *httptest.Server {
	t.Helper()
	versionBody := s.versionBody
	if versionBody == "" {
		versionBody = `{"version":"dev-abc1234"}`
	}
	bundleBody := s.bundleBody
	if bundleBody == nil {
		bundleBody = []byte("STUB-BUNDLE-BYTES")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, _ *http.Request) {
		status := s.versionStatus
		if status == 0 {
			status = http.StatusOK
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(versionBody))
	})
	mux.HandleFunc("/api/workspaces/bundle-all", func(w http.ResponseWriter, r *http.Request) {
		if s.captureBundleQuery != nil {
			s.captureBundleQuery(r.URL.RawQuery)
		}
		if s.bundleDelay > 0 {
			time.Sleep(s.bundleDelay)
		}
		status := s.bundleStatus
		if status == 0 {
			status = http.StatusOK
		}
		w.Header().Set("Content-Type", "application/zip")
		w.WriteHeader(status)
		_, _ = w.Write(bundleBody)
	})
	return httptest.NewServer(mux)
}

// newDaemonStubTLS is the https-server flavor — same handlers, TLS
// cert from httptest. Confirms newDaemonClient wires InsecureSkipVerify
// for https URLs.
func newDaemonStubTLS(t *testing.T, s daemonStub) *httptest.Server {
	t.Helper()
	versionBody := s.versionBody
	if versionBody == "" {
		versionBody = `{"version":"dev-abc1234"}`
	}
	bundleBody := s.bundleBody
	if bundleBody == nil {
		bundleBody = []byte("STUB-BUNDLE-BYTES")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(versionBody))
	})
	mux.HandleFunc("/api/workspaces/bundle-all", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/zip")
		_, _ = w.Write(bundleBody)
	})
	return httptest.NewTLSServer(mux)
}

func TestExport_HTTP_HappyPath(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	srv := newDaemonStub(t, daemonStub{})
	defer srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// workspaces.zip present + correct bytes IS the "workspaces embedded"
	// assertion — the manifest no longer restates it.
	gotBundle := readZipFile(t, zipPath, "workspaces.zip")
	if string(gotBundle) != "STUB-BUNDLE-BYTES" {
		t.Errorf("workspaces.zip body = %q, want canned bytes", string(gotBundle))
	}
	manifestBody := string(readZipFile(t, zipPath, "manifest.yml"))
	for _, needle := range []string{
		"daemon_version: dev-abc1234",
		"include_workspaces_requested: true",
	} {
		if !strings.Contains(manifestBody, needle) {
			t.Errorf("manifest missing %q\n%s", needle, manifestBody)
		}
	}
	if strings.Contains(manifestBody, "what: workspaces") {
		t.Errorf("manifest unexpectedly skipped workspaces:\n%s", manifestBody)
	}
}

// TestExport_HTTP_BundleModeDefinition pins the privacy brake: the
// /bundle-all request MUST carry ?mode=definition (design § "Out of
// Scope") so narrative memory is excluded from the bundle. Drop or
// typo the param in export.go and this test goes red while the rest
// of the HTTP suite stays green.
func TestExport_HTTP_BundleModeDefinition(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")

	var mu sync.Mutex
	var gotQuery string
	srv := newDaemonStub(t, daemonStub{
		captureBundleQuery: func(rawQuery string) {
			mu.Lock()
			gotQuery = rawQuery
			mu.Unlock()
		},
	})
	defer srv.Close()

	if _, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
	}); err != nil {
		t.Fatalf("Export: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if got := mustQueryMode(t, gotQuery); got != "definition" {
		t.Errorf("bundle-all mode = %q, want %q (raw query %q)", got, "definition", gotQuery)
	}
}

func mustQueryMode(t *testing.T, rawQuery string) string {
	t.Helper()
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatalf("parse bundle-all query %q: %v", rawQuery, err)
	}
	return values.Get("mode")
}

func TestExport_HTTP_DaemonUnreachable(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	// Bind a real port, then close it — guarantees the connect refuses.
	srv := httptest.NewServer(http.NewServeMux())
	closedURL := srv.URL
	srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         closedURL,
		OutputDir:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "daemon_version: unreachable") {
		t.Errorf("manifest missing daemon_version: unreachable\n%s", body)
	}
	if !strings.Contains(body, "why: daemon_unreachable") {
		t.Errorf("manifest missing why: daemon_unreachable\n%s", body)
	}
}

func TestExport_HTTP_AuthRefused(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	srv := newDaemonStub(t, daemonStub{bundleStatus: http.StatusUnauthorized})
	defer srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	for _, name := range readZipEntries(t, zipPath) {
		if name == "workspaces.zip" {
			t.Errorf("workspaces.zip present despite 401")
		}
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "why: auth_refused") {
		t.Errorf("manifest missing why: auth_refused\n%s", body)
	}
}

func TestExport_HTTP_5xx(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	srv := newDaemonStub(t, daemonStub{bundleStatus: http.StatusServiceUnavailable})
	defer srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "why: daemon_returned_5xx") {
		t.Errorf("manifest missing why: daemon_returned_5xx\n%s", body)
	}
}

func TestExport_HTTP_BundleAllTimeout(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	srv := newDaemonStub(t, daemonStub{bundleDelay: 200 * time.Millisecond})
	defer srv.Close()

	opts := ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
		bundleAllTimeout:  20 * time.Millisecond,
	}
	zipPath, err := Export(opts)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "why: bundle_all_timeout") {
		t.Errorf("manifest missing why: bundle_all_timeout\n%s", body)
	}
}

func TestExport_HTTP_BundleTooLarge(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	// Serve a body larger than the test-injected cap.
	srv := newDaemonStub(t, daemonStub{bundleBody: make([]byte, 64)})
	defer srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
		bundleAllByteCap:  32,
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	for _, name := range readZipEntries(t, zipPath) {
		if name == "workspaces.zip" {
			t.Errorf("workspaces.zip present despite body exceeding cap")
		}
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "why: bundle_all_too_large") {
		t.Errorf("manifest missing why: bundle_all_too_large\n%s", body)
	}
}

func TestExport_HTTP_TLS_InsecureSkipVerify(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	srv := newDaemonStubTLS(t, daemonStub{})
	defer srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	gotBundle := readZipFile(t, zipPath, "workspaces.zip")
	if string(gotBundle) != "STUB-BUNDLE-BYTES" {
		t.Errorf("workspaces.zip body = %q, want canned bytes (TLS handshake may have failed)", string(gotBundle))
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "daemon_version: dev-abc1234") {
		t.Errorf("manifest missing daemon_version: dev-abc1234\n%s", body)
	}
}

// TestExport_HTTP_VersionFailsButBundleSucceeds covers the case where
// /api/version returns 500 but /bundle-all is healthy — manifest must
// record daemon_version: unreachable while still embedding workspaces.
// Guards against a future refactor coupling the two calls.
func TestExport_HTTP_VersionFailsButBundleSucceeds(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")
	srv := newDaemonStub(t, daemonStub{versionStatus: http.StatusInternalServerError})
	defer srv.Close()

	zipPath, err := Export(ExportOptions{
		IncludeWorkspaces: true,
		DaemonURL:         srv.URL,
		OutputDir:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "daemon_version: unreachable") {
		t.Errorf("manifest missing daemon_version: unreachable\n%s", body)
	}
	// Workspaces still embedded despite the version call failing — assert
	// via the actual archive entry, not a manifest claim.
	gotBundle := readZipFile(t, zipPath, "workspaces.zip")
	if string(gotBundle) != "STUB-BUNDLE-BYTES" {
		t.Errorf("workspaces.zip body = %q, want canned bytes (bundle should succeed even when version fails)", string(gotBundle))
	}
}
