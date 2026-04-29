// Package cloudflared resolves a usable cloudflared binary for the
// tunnel manager. Discovery has four tiers: sibling of own binary →
// $PATH → ~/.atlas/bin (cached prior download) → in-Go HTTPS download
// from github.com/cloudflare/cloudflared releases.
//
// Downloads are atomic: tmp.<pid> → fsync → verify against the digest
// reported by GitHub's releases API → atomic rename. A
// partial/interrupted download leaves no cached binary so the next
// call re-downloads. Bumping Version is a one-line change; the
// expected hash is queried per-call from
// api.github.com/repos/cloudflare/cloudflared/releases/tags/<version>.
//
// All public callers go through Resolve. Concurrent Resolve calls
// inside one process are coalesced to a single download.
package cloudflared

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Version is the pinned cloudflared release we download. Bumping
// this is a one-line change — the expected hash is fetched at
// download time from GitHub's releases API.
const Version = "2026.3.0"

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
	wantHex, err := fetchAssetDigest(ctx, Version, assetName(url))
	if err != nil {
		return "", fmt.Errorf("fetch asset digest: %w", err)
	}

	dst := cachedPath()
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", fmt.Errorf("create cache dir: %w", err)
	}
	tmp := fmt.Sprintf("%s.tmp.%d", dst, os.Getpid())
	defer func() { _ = os.Remove(tmp) }() // best-effort cleanup if we don't reach the rename

	hashHex, err := downloadToTmp(ctx, url, tmp)
	if err != nil {
		return "", err
	}

	if hashHex != wantHex {
		return "", fmt.Errorf("sha256 mismatch: download=%s upstream=%s", hashHex, wantHex)
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

// assetName returns the file portion of a release-asset URL.
func assetName(url string) string {
	return path.Base(url)
}

// fetchAssetDigest queries GitHub's releases API for the named asset
// in the pinned release tag and returns its sha256 hex digest. The
// `digest` field GitHub reports is formatted "sha256:<hex>".
func fetchAssetDigest(ctx context.Context, version, asset string) (string, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/cloudflare/cloudflared/releases/tags/%s", version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := downloadHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub releases API HTTP %d", resp.StatusCode)
	}
	var rel struct {
		Assets []struct {
			Name   string `json:"name"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", fmt.Errorf("decode release JSON: %w", err)
	}
	for _, a := range rel.Assets {
		if a.Name != asset {
			continue
		}
		hex, ok := strings.CutPrefix(a.Digest, "sha256:")
		if !ok || len(hex) != 64 {
			return "", fmt.Errorf("asset %q: unexpected digest %q", asset, a.Digest)
		}
		return strings.ToLower(hex), nil
	}
	return "", fmt.Errorf("asset %q not found in release %s", asset, version)
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
