// Package cloudflared resolves a usable cloudflared binary for the
// tunnel manager. Discovery has four tiers: sibling of own binary →
// $PATH → ~/.atlas/bin (cached prior download) → in-Go HTTPS download
// from github.com/cloudflare/cloudflared releases.
//
// Downloads are atomic: tmp.<pid> → fsync → verify against a hash
// pinned in this file → atomic rename. A partial/interrupted download
// leaves no cached binary so the next call re-downloads.
//
// Cloudflare doesn't publish .sha256 sidecars on its releases, so the
// hashes are pinned per-arch alongside Version. Bumping the version
// is a two-step change: update Version, regenerate the hashes. The
// release page on github.com/cloudflare/cloudflared is the source of
// truth for both.
//
// All public callers go through Resolve. Concurrent Resolve calls
// inside one process are coalesced to a single download.
package cloudflared

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Version is the pinned cloudflared release we download. Bumping this
// requires also regenerating the entries in releaseHashes — see the
// package doc for how.
const Version = "2025.11.1"

// releaseHashes is the sha256 of each per-arch asset for the pinned
// Version. Regenerate by downloading each artifact:
//
//	for a in cloudflared-darwin-arm64.tgz cloudflared-darwin-amd64.tgz \
//	         cloudflared-linux-amd64 cloudflared-linux-arm64 \
//	         cloudflared-windows-amd64.exe; do
//	  curl -sL "https://github.com/cloudflare/cloudflared/releases/download/${Version}/$a" \
//	    | shasum -a 256
//	done
var releaseHashes = map[string]string{
	"darwin/arm64":  "45cfbb59a720f60b873906aa6469f8c4058f26be6d351c3e2920bc9cb4714273",
	"darwin/amd64":  "155a288fef19dba08f0c7145c16a207baf137462d8a1289a78bf8564f9e51244",
	"linux/amd64":   "991dffd8889ee9f0147b6b48933da9e4407e68ea8c6d984f55fa2d3db4bb431d",
	"linux/arm64":   "9979dc152097a29b6de4d1ef13e2f1821c67a6f096f88cc18f0fd25106305d3a",
	"windows/amd64": "413f9b24dc6e61a455564651524f167b8ce29ac4ccd40703dea7af93cd37ed39",
}

// downloadHTTPClient is a package-level HTTP client with a sane timeout.
// The download itself can take a while on slow links; a per-request
// context with a longer deadline supersedes this when needed.
var downloadHTTPClient = &http.Client{Timeout: 5 * time.Minute}

// resolveOnce coalesces concurrent in-process Resolve calls keyed on
// the pinned version constant. If two goroutines call Resolve()
// simultaneously on a missing-binary machine, only one download fires.
var resolveOnce sync.Map // version → *resolveResult

type resolveResult struct {
	once sync.Once
	path string
	err  error
}

// Resolve returns a path to a usable cloudflared binary, downloading
// to ~/.atlas/bin/ if discovery comes up empty. The returned path is
// safe to pass directly to exec.Command.
func Resolve(ctx context.Context) (string, error) {
	if path, ok := lookupSibling(); ok {
		return path, nil
	}
	if path, err := exec.LookPath("cloudflared"); err == nil {
		return path, nil
	}
	cached := cachedPath()
	if _, err := os.Stat(cached); err == nil {
		return cached, nil
	}
	return downloadCoalesced(ctx)
}

// lookupSibling returns the cloudflared path adjacent to our own
// binary (e.g. ~/.friday/local/cloudflared sitting next to
// ~/.friday/local/webhook-tunnel). This is the studio-install layout.
func lookupSibling() (string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	dir := filepath.Dir(exe)
	candidate := filepath.Join(dir, "cloudflared")
	if runtime.GOOS == "windows" {
		candidate += ".exe"
	}
	if _, err := os.Stat(candidate); err == nil {
		return candidate, true
	}
	return "", false
}

// cachedPath returns the canonical cache location.
func cachedPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		// Best-effort fallback to /tmp so the download doesn't fail
		// on a misconfigured system.
		return "/tmp/cloudflared"
	}
	bin := filepath.Join(home, ".atlas", "bin", "cloudflared")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	return bin
}

func downloadCoalesced(ctx context.Context) (string, error) {
	v, _ := resolveOnce.LoadOrStore(Version, &resolveResult{})
	rr := v.(*resolveResult)
	rr.once.Do(func() {
		rr.path, rr.err = downloadAtomic(ctx)
	})
	return rr.path, rr.err
}

// releaseURL returns the URL of the cloudflared binary asset for the
// current GOOS/GOARCH on the pinned version. Cloudflared publishes
// per-platform binaries directly (no tarball) so the URL points at
// the executable file.
func releaseURL(version string) (string, error) {
	base := fmt.Sprintf("https://github.com/cloudflare/cloudflared/releases/download/%s", version)
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64":
		return base + "/cloudflared-darwin-arm64.tgz", nil
	case "darwin/amd64":
		return base + "/cloudflared-darwin-amd64.tgz", nil
	case "linux/amd64":
		return base + "/cloudflared-linux-amd64", nil
	case "linux/arm64":
		return base + "/cloudflared-linux-arm64", nil
	case "windows/amd64":
		return base + "/cloudflared-windows-amd64.exe", nil
	default:
		return "", fmt.Errorf("cloudflared: no release artifact for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
}

// downloadAtomic implements the tmp → fsync → verify → rename
// protocol described in the package doc. macOS releases ship as
// tar.gz containing the binary; non-macOS ships the bare binary.
// We delegate the macOS unpack to a helper since the rest of the
// flow is identical.
func downloadAtomic(ctx context.Context) (string, error) {
	url, err := releaseURL(Version)
	if err != nil {
		return "", err
	}
	wantHex, ok := releaseHashes[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return "", fmt.Errorf("cloudflared: no pinned hash for %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	dst := cachedPath()
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", fmt.Errorf("create cache dir: %w", err)
	}
	tmp := fmt.Sprintf("%s.tmp.%d", dst, os.Getpid())
	defer func() { _ = os.Remove(tmp) }() // best-effort cleanup if we don't reach the rename

	// Download body to tmp + compute sha256 in one pass.
	hashHex, err := downloadToTmp(ctx, url, tmp)
	if err != nil {
		return "", err
	}

	if hashHex != wantHex {
		return "", fmt.Errorf("sha256 mismatch: download=%s pinned=%s", hashHex, wantHex)
	}

	// macOS releases ship the binary inside a tarball; unpack and
	// overwrite tmp with the inner file before the final rename.
	if strings.HasSuffix(url, ".tgz") {
		if err := unpackDarwinTarball(tmp); err != nil {
			return "", err
		}
	}

	if err := os.Chmod(tmp, 0o700); err != nil { //nolint:gosec // G302: executable needs +x
		return "", fmt.Errorf("chmod: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		return "", fmt.Errorf("rename to final path: %w", err)
	}
	return dst, nil
}

// downloadToTmp streams the URL into tmp, hashing as it goes. Returns
// the hex sha256 of the bytes written.
func downloadToTmp(ctx context.Context, url, tmp string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := downloadHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download GET: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download HTTP %d", resp.StatusCode)
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600) //nolint:gosec // G304: tmp is a path we computed inside this package
	if err != nil {
		return "", fmt.Errorf("open tmp: %w", err)
	}
	hasher := sha256.New()
	mw := io.MultiWriter(f, hasher)
	if _, err := io.Copy(mw, resp.Body); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("download copy: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("fsync: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}
