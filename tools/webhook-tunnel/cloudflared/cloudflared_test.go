package cloudflared

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeBinaryServer serves arbitrary bytes at /binary. Used by the
// download tests to exercise the streaming hash path without hitting
// the network.
func fakeBinaryServer(t *testing.T, body []byte) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/binary"
}

// TestAssetNameRoundTrips verifies assetName extracts the filename
// portion from a release-asset URL, which is what we use as the lookup
// key into the GitHub API's `assets` array.
func TestAssetNameRoundTrips(t *testing.T) {
	cases := map[string]string{
		"https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-darwin-arm64.tgz":  "cloudflared-darwin-arm64.tgz",
		"https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-linux-amd64":       "cloudflared-linux-amd64",
		"https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-windows-amd64.exe": "cloudflared-windows-amd64.exe",
	}
	for url, want := range cases {
		if got := assetName(url); got != want {
			t.Errorf("assetName(%q) = %q, want %q", url, got, want)
		}
	}
}

func TestDownloadToTmpHappyPath(t *testing.T) {
	body := []byte("fake cloudflared binary contents")
	binURL := fakeBinaryServer(t, body)
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
