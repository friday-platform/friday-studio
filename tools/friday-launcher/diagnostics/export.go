// Package diagnostics produces a one-click diagnostic zip for Friday
// launcher bug reports (issue #324). Public surface is the Export
// function — the caller passes options and gets a path to a finished
// zip whose internal shape is documented in the bundled manifest.yml.
//
// This iteration is the tracer bullet (task #2): logs + state.json +
// pids + manifest. Workspace inclusion via the daemon's /bundle-all
// route lands in task #3 by swapping the bodies of getDaemonVersion
// and fetchWorkspaces; the manifest contract does not change.
package diagnostics

import (
	"archive/zip"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ExportOptions configures one diagnostic export. All fields are
// optional. The zero value runs against the user's real
// ~/.friday/local data and writes to ~/Downloads.
type ExportOptions struct {
	// IncludeWorkspaces, when true and DaemonURL is set, instructs
	// the export to call /api/workspaces/bundle-all and embed the
	// response as workspaces.zip. Any failure (transport, non-2xx,
	// timeout) records a stable skip-reason in the manifest and the
	// export still succeeds.
	IncludeWorkspaces bool

	// DaemonURL is the base URL the export uses for daemon HTTP
	// calls (/api/version always; /api/workspaces/bundle-all when
	// IncludeWorkspaces is true). Empty disables both calls —
	// daemon_version becomes "unreachable" and workspaces is skipped
	// with daemon_unreachable.
	DaemonURL string

	// OutputDir is where the final zip is written. Empty → ~/Downloads.
	// If the chosen directory is not writable, the export falls back
	// to os.TempDir() and records the skip in the manifest.
	OutputDir string

	// ProgressFn, if non-nil, is invoked with phase strings as the
	// export progresses. Phases: "logs", "packaging" by default;
	// when IncludeWorkspaces is true AND DaemonURL is non-empty the
	// sequence becomes "logs", "workspaces", "packaging".
	ProgressFn func(phase string)

	// bundleAllTimeout, when non-zero, overrides the default 60s
	// bound on the /bundle-all call. Unexported test-only knob —
	// production callers get the 60s default.
	bundleAllTimeout time.Duration

	// bundleAllByteCap, when non-zero, overrides the default
	// defaultBundleAllByteCap on how many bytes the /bundle-all
	// response body may occupy. Unexported test-only knob —
	// production callers get the default cap.
	bundleAllByteCap int64
}

// Package-level seams that tests swap. Production callers see them
// as opaque — they resolve real on-disk locations via friendlyHome.
var (
	sourceLogsDir  = defaultLogsDir
	sourceStateDir = defaultStateDir
	nowFn          = func() time.Time { return time.Now().UTC() }
)

// friendlyHome mirrors the launcher package's friendlyHome (paths.go)
// — the FRIDAY_LAUNCHER_HOME override is the load-bearing knob for
// integration scenarios that don't want to touch the real home dir.
func friendlyHome() string {
	if v := os.Getenv("FRIDAY_LAUNCHER_HOME"); v != "" {
		return v
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".friday", "local")
	}
	return filepath.Join(os.TempDir(), ".friday", "local")
}

func defaultLogsDir() string  { return filepath.Join(friendlyHome(), "logs") }
func defaultStateDir() string { return friendlyHome() }

// Export builds the diagnostic zip and returns its path. A non-nil
// error means no zip was produced. A nil error means a valid zip
// exists at the returned path; any pieces that couldn't be included
// are documented in the bundled manifest.yml under skipped[].
func Export(opts ExportOptions) (string, error) {
	outDir, outDirSkipped, err := resolveOutputDir(opts.OutputDir)
	if err != nil {
		return "", fmt.Errorf("resolve output dir: %w", err)
	}

	zipPath, tmpPath := buildPaths(outDir, nowFn())

	// Always clean up the partial. If Rename succeeded the path no
	// longer exists and Remove is a harmless no-op; if any step
	// before Rename errored, this is what stops aborted exports from
	// accumulating in Downloads.
	defer func() { _ = os.Remove(tmpPath) }()

	if err := writeBundle(tmpPath, opts, outDirSkipped); err != nil {
		return "", err
	}

	if err := os.Rename(tmpPath, zipPath); err != nil {
		return "", fmt.Errorf("rename %s -> %s: %w", tmpPath, zipPath, err)
	}
	return zipPath, nil
}

// writeBundle writes every entry into the zip at tmpPath.
//
// zip.Writer.Close MUST run before the file's Close — that's when the
// central directory is flushed. The file Close happens via a named-
// return defer so a real error always wins over a close error, but
// a close-only failure still surfaces (instead of being silently
// swallowed like a bare `defer f.Close()` would).
func writeBundle(tmpPath string, opts ExportOptions, outDirSkipped bool) (err error) {
	f, err := os.Create(tmpPath) //nolint:gosec // G304: launcher-resolved output dir (Downloads/TempDir/explicit), no user input
	if err != nil {
		return fmt.Errorf("create %s: %w", tmpPath, err)
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close zip file: %w", cerr)
		}
	}()

	zw := zip.NewWriter(f)

	progress(opts.ProgressFn, "logs")
	if err := addLogs(zw, sourceLogsDir()); err != nil {
		return err
	}

	if err := addStateJSON(zw, filepath.Join(sourceStateDir(), "state.json")); err != nil {
		return err
	}

	if err := addPids(zw, filepath.Join(sourceStateDir(), "pids")); err != nil {
		return err
	}

	// /api/version is called BEFORE any workspaces work — design v3
	// § "Daemon /api/version endpoint" makes the order explicit so a
	// future short-circuit ("skip workspaces if version unreachable")
	// has an honest signal to read.
	daemonVersion := getDaemonVersion(opts)

	wsResult := fetchWorkspaces(opts)
	if wsResult.body != nil {
		if err := writeZipEntry(zw, "workspaces.zip", wsResult.body); err != nil {
			return err
		}
	}

	progress(opts.ProgressFn, "packaging")

	m := buildManifest(opts, outDirSkipped, daemonVersion, wsResult)
	body, err := marshalManifest(m)
	if err != nil {
		return fmt.Errorf("marshal manifest: %w", err)
	}
	if err := writeZipEntry(zw, "manifest.yml", body); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("close zip writer: %w", err)
	}
	return nil
}

// buildManifest assembles the manifest struct from inputs gathered
// upstream. Pure assembly — every HTTP call has already happened by
// the time we get here.
func buildManifest(opts ExportOptions, outDirSkipped bool, daemonVersion string, ws workspaceResult) manifest {
	skipped := []manifestSkip{}
	if !opts.IncludeWorkspaces {
		skipped = append(skipped, manifestSkip{
			What: "workspaces",
			Why:  skipReasonUserOptedOut,
		})
	} else if ws.body == nil {
		skipped = append(skipped, manifestSkip{
			What: "workspaces",
			Why:  ws.skipReason,
		})
	}
	if outDirSkipped {
		skipped = append(skipped, manifestSkip{
			What: "output_dir",
			Why:  skipReasonDownloadsUnwritable,
		})
	}
	return manifest{
		DaemonVersion:              daemonVersion,
		OS:                         runtime.GOOS,
		Arch:                       runtime.GOARCH,
		GeneratedAt:                nowFn(),
		IncludeWorkspacesRequested: opts.IncludeWorkspaces,
		Skipped:                    skipped,
	}
}

// getDaemonVersion calls GET <DaemonURL>/api/version and returns the
// `version` field from the response. Any failure — empty DaemonURL,
// transport error, non-2xx, malformed body, timeout — collapses to
// the reserved daemonVersionUnreachable literal so the manifest stays
// machine-parseable.
//
// Bounded by a short context (versionTimeout); /api/version is a
// constant-time handler so a long deadline only hides a hung daemon.
func getDaemonVersion(opts ExportOptions) string {
	if opts.DaemonURL == "" {
		return daemonVersionUnreachable
	}
	client, err := newDaemonClient(opts.DaemonURL)
	if err != nil {
		return daemonVersionUnreachable
	}
	endpoint, err := joinDaemonURL(opts.DaemonURL, "/api/version")
	if err != nil {
		return daemonVersionUnreachable
	}
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return daemonVersionUnreachable
	}
	resp, err := client.Do(req)
	if err != nil {
		return daemonVersionUnreachable
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return daemonVersionUnreachable
	}
	var payload struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return daemonVersionUnreachable
	}
	if payload.Version == "" {
		return daemonVersionUnreachable
	}
	return payload.Version
}

// workspaceResult is the outcome of fetchWorkspaces. Exactly one of
// {body, skipReason} is meaningful: a non-nil body means success
// (skipReason is empty); a nil body means skip with the recorded
// reason. The two-field shape avoids allocating a sentinel error per
// skip and keeps the manifest mapping in buildManifest a one-liner.
type workspaceResult struct {
	body       []byte
	skipReason string
}

// fetchWorkspaces calls GET <DaemonURL>/api/workspaces/bundle-all?mode=definition
// when IncludeWorkspaces is true and DaemonURL is set; otherwise it
// returns the zero value (caller treats nil body as "no embed"). The
// returned body is intentionally raw bytes from the server — embedded
// verbatim as workspaces.zip with no re-zip or unwrap.
func fetchWorkspaces(opts ExportOptions) workspaceResult {
	if !opts.IncludeWorkspaces || opts.DaemonURL == "" {
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	progress(opts.ProgressFn, "workspaces")
	client, err := newDaemonClient(opts.DaemonURL)
	if err != nil {
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	endpoint, err := joinDaemonURL(opts.DaemonURL, "/api/workspaces/bundle-all")
	if err != nil {
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	endpoint += "?mode=definition"
	timeout := opts.bundleAllTimeout
	if timeout == 0 {
		timeout = defaultBundleAllTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	resp, err := client.Do(req)
	if err != nil {
		// context.DeadlineExceeded surfaces as a wrapped url.Error
		// whose Err chains to ctx.Err(); errors.Is unwraps it.
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return workspaceResult{skipReason: skipReasonBundleAllTimeout}
		}
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return workspaceResult{skipReason: skipReasonAuthRefused}
	case resp.StatusCode >= 500 && resp.StatusCode < 600:
		return workspaceResult{skipReason: skipReasonDaemonReturned5xx}
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	byteCap := opts.bundleAllByteCap
	if byteCap == 0 {
		byteCap = defaultBundleAllByteCap
	}
	// Read one byte past the cap so a body sitting exactly at the cap
	// is kept while anything larger trips the skip below.
	body, err := io.ReadAll(io.LimitReader(resp.Body, byteCap+1))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return workspaceResult{skipReason: skipReasonBundleAllTimeout}
		}
		return workspaceResult{skipReason: skipReasonDaemonUnreachable}
	}
	if int64(len(body)) > byteCap {
		return workspaceResult{skipReason: skipReasonBundleAllTooLarge}
	}
	return workspaceResult{body: body}
}

// versionTimeout bounds the /api/version call. /api/version is a
// constant-time handler — anything past a couple seconds means the
// daemon is wedged, not slow.
const versionTimeout = 5 * time.Second

// defaultBundleAllTimeout bounds /api/workspaces/bundle-all in
// production. Tests override via ExportOptions.bundleAllTimeout.
const defaultBundleAllTimeout = 60 * time.Second

// defaultBundleAllByteCap bounds how many bytes of the /bundle-all
// response fetchWorkspaces buffers. The 60s timeout bounds latency,
// not size — a power user with many/large workspaces (this feature's
// persona) could otherwise balloon launcher RSS. Tests override via
// ExportOptions.bundleAllByteCap.
const defaultBundleAllByteCap = 256 << 20 // 256 MB

// newDaemonClient returns the http.Client used for all daemon calls.
// Mirrors newReadinessClient(scheme) in readiness.go: plain HTTP gets
// a vanilla client; HTTPS clones DefaultTransport and pins a
// skip-verify TLS config (loopback to our private-CA-signed daemon
// has no MITM surface — same rationale as the readiness probe).
//
// Client.Timeout is zero — every caller uses context.WithTimeout so
// the deadline covers connect + TLS + headers + body together.
func newDaemonClient(daemonURL string) (*http.Client, error) {
	u, err := url.Parse(daemonURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" {
		return &http.Client{Timeout: 0}, nil
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	//nolint:gosec // G402: loopback-only daemon call, matches readiness.go rationale
	tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	return &http.Client{Timeout: 0, Transport: tr}, nil
}

// joinDaemonURL joins a base daemon URL with a path. Returns an error
// only if the base URL is unparseable; callers collapse the error to
// a skip in the manifest.
func joinDaemonURL(base, path string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	return u.String(), nil
}

// addLogs copies every live .log file from logsDir into zw's logs/
// subdir. "Live" = filename ends in exactly .log (no .gz, no .log.N).
// A missing logs dir is not an error — the zip just has no logs/.
func addLogs(zw *zip.Writer, logsDir string) error {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read logs dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".log") {
			continue
		}
		if err := addFileFromDisk(zw, filepath.Join(logsDir, name), "logs/"+name); err != nil {
			return err
		}
	}
	return nil
}

func addStateJSON(zw *zip.Writer, path string) error {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat state.json: %w", err)
	}
	return addFileFromDisk(zw, path, "state.json")
}

// addPids copies every entry from pidsDir into zw's pids/ subdir. A
// missing pids dir is not an error — the zip just has no pids/.
func addPids(zw *zip.Writer, pidsDir string) error {
	entries, err := os.ReadDir(pidsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read pids dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if err := addFileFromDisk(zw, filepath.Join(pidsDir, name), "pids/"+name); err != nil {
			return err
		}
	}
	return nil
}

func addFileFromDisk(zw *zip.Writer, srcPath, zipName string) error {
	src, err := os.Open(srcPath) //nolint:gosec // G304: launcher-controlled paths under $HOME/.friday/local (logs/state/pids)
	if err != nil {
		return fmt.Errorf("open %s: %w", srcPath, err)
	}
	defer func() { _ = src.Close() }()
	w, err := zw.Create(zipName)
	if err != nil {
		return fmt.Errorf("zip create %s: %w", zipName, err)
	}
	if _, err := io.Copy(w, src); err != nil {
		return fmt.Errorf("zip copy %s: %w", zipName, err)
	}
	return nil
}

func writeZipEntry(zw *zip.Writer, name string, body []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return fmt.Errorf("zip create %s: %w", name, err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("zip write %s: %w", name, err)
	}
	return nil
}

func progress(fn func(string), phase string) {
	if fn == nil {
		return
	}
	fn(phase)
}

// resolveOutputDir picks the directory the zip will be written to.
// Order of preference: explicit OutputDir → ~/Downloads → os.TempDir().
// Returns the chosen dir and a bool telling buildManifest whether a
// downloads_unwritable skip needs to be recorded.
func resolveOutputDir(explicit string) (string, bool, error) {
	candidates := []string{}
	if explicit != "" {
		candidates = append(candidates, explicit)
	} else {
		candidates = append(candidates, downloadsDir())
	}
	for _, c := range candidates {
		if writable(c) {
			return c, false, nil
		}
	}
	// Fallback: TempDir. os.TempDir on every supported platform is
	// always writable to the current user; if it isn't, the user has
	// bigger problems than diagnostics export.
	tmp := os.TempDir()
	if !writable(tmp) {
		return "", false, fmt.Errorf("no writable output directory found (tried %v and %s)", candidates, tmp)
	}
	return tmp, true, nil
}

// downloadsDir returns ~/Downloads. Falls back to os.TempDir if the
// user's home can't be resolved — writable() will accept that and we
// still record the fallback in the manifest via outDirSkipped.
func downloadsDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "Downloads")
	}
	return os.TempDir()
}

// writable returns true iff a probe file can be created and removed
// inside dir. Cheap (one create + one remove); the cost is paid at
// most twice per export.
func writable(dir string) bool {
	if dir == "" {
		return false
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}
	probe, err := os.CreateTemp(dir, ".friday-write-probe-*")
	if err != nil {
		return false
	}
	_ = probe.Close()
	_ = os.Remove(probe.Name())
	return true
}

// buildPaths derives the final + partial zip paths. On filename
// collision (same-second back-to-back exports) appends nanoseconds
// once to disambiguate.
func buildPaths(outDir string, now time.Time) (zipPath, tmpPath string) {
	base := "friday-diagnostics-" + now.Format("2006-01-02-150405")
	zipPath = filepath.Join(outDir, base+".zip")
	if _, statErr := os.Stat(zipPath); statErr == nil {
		base = fmt.Sprintf("%s-%09d", base, now.Nanosecond())
		zipPath = filepath.Join(outDir, base+".zip")
	}
	tmpPath = filepath.Join(outDir, "."+base+".zip.partial")
	return zipPath, tmpPath
}
