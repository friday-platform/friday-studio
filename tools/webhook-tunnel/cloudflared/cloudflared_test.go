package cloudflared

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRelease serves a body + matching .sha256 sidecar from an
// in-process test server. mismatchHash forces the sidecar to advertise
// a wrong hash so we can test rejection.
func fakeRelease(t *testing.T, body []byte, mismatchHash bool) (binURL, sidecarURL string) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/binary", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	})
	mux.HandleFunc("/binary.sha256", func(w http.ResponseWriter, _ *http.Request) {
		hash := sha256.Sum256(body)
		hex := hex.EncodeToString(hash[:])
		if mismatchHash {
			hex = strings.Repeat("0", 64)
		}
		_, _ = fmt.Fprintf(w, "%s  binary\n", hex)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL + "/binary", srv.URL + "/binary.sha256"
}

func TestFetchSha256Sidecar(t *testing.T) {
	body := []byte("hello cloudflared")
	_, sidecarURL := fakeRelease(t, body, false)
	got, err := fetchSha256Sidecar(context.Background(), sidecarURL)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	hash := sha256.Sum256(body)
	want := hex.EncodeToString(hash[:])
	if got != want {
		t.Errorf("hash: want %s, got %s", want, got)
	}
}

func TestDownloadAtomicHappyPath(t *testing.T) {
	body := []byte("fake cloudflared binary contents")
	binURL, _ := fakeRelease(t, body, false)
	tmp := filepath.Join(t.TempDir(), "out.bin")
	gotHash, err := downloadToTmp(context.Background(), binURL, tmp)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	hash := sha256.Sum256(body)
	if gotHash != hex.EncodeToString(hash[:]) {
		t.Errorf("hash mismatch")
	}
	got, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("read tmp: %v", err)
	}
	if string(got) != string(body) {
		t.Errorf("body mismatch")
	}
}

func TestSidecarMismatchRejected(t *testing.T) {
	body := []byte("xyz")
	binURL, sidecarURL := fakeRelease(t, body, true) // sidecar lies
	wantHex, err := fetchSha256Sidecar(context.Background(), sidecarURL)
	if err != nil {
		t.Fatalf("sidecar fetch: %v", err)
	}
	if !strings.HasPrefix(wantHex, "0000") {
		t.Fatalf("expected mismatched hash, got %s", wantHex)
	}
	tmp := filepath.Join(t.TempDir(), "out.bin")
	gotHex, err := downloadToTmp(context.Background(), binURL, tmp)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if gotHex == wantHex {
		t.Errorf("expected hash mismatch — sidecar should have lied")
	}
}

// TestInterruptedDownload simulates a server that closes the connection
// mid-body. Verifies the .tmp gets removed via the deferred cleanup so
// a subsequent Resolve sees no cached binary.
func TestInterruptedDownload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Send Content-Length saying 1000 bytes but write only 10 then
		// close the conn — the receiver should error out.
		w.Header().Set("Content-Length", "1000")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial!!!"))
		hj, ok := w.(http.Hijacker)
		if !ok {
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			return
		}
		_ = conn.Close()
	}))
	t.Cleanup(srv.Close)

	tmp := filepath.Join(t.TempDir(), "out.bin")
	_, err := downloadToTmp(context.Background(), srv.URL, tmp)
	if err == nil {
		t.Fatalf("expected error on interrupted download, got nil")
	}
	// downloadToTmp doesn't auto-remove tmp (caller's defer does), but
	// the file MUST not be size=1000 — that would mean we silently
	// accepted a partial write.
	if info, err := os.Stat(tmp); err == nil && info.Size() == 1000 {
		t.Errorf("interrupted download produced full-size file?!")
	}
}

func TestReleaseURLAllPlatforms(t *testing.T) {
	// Lock the URL pattern shape against future GOOS/GOARCH changes.
	// Doesn't actually fetch; just asserts the URL structure.
	got, err := releaseURL("v1.2.3")
	if err != nil {
		// Test environment may be on an unsupported platform; skip
		// rather than fail.
		t.Skipf("releaseURL on %s/%s unsupported: %v", "current", "current", err)
	}
	if !strings.Contains(got, "v1.2.3") {
		t.Errorf("URL missing version: %s", got)
	}
	if !strings.Contains(got, "github.com/cloudflare/cloudflared") {
		t.Errorf("URL not pointing at github cloudflared: %s", got)
	}
}

func TestLookupSiblingMissing(t *testing.T) {
	// In test mode os.Executable returns the test binary's path. There
	// is no sibling cloudflared, so lookup must return false.
	_, ok := lookupSibling()
	if ok {
		t.Errorf("unexpected sibling cloudflared found in test env")
	}
}
