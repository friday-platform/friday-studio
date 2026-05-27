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
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// ExportOptions configures one diagnostic export. All fields are
// optional. The zero value runs against the user's real
// ~/.friday/local data and writes to ~/Downloads.
type ExportOptions struct {
	// IncludeWorkspaces, when true, signals user intent to ship
	// workspace bundles. This iteration has no HTTP path to the
	// daemon, so the manifest records skip-reason daemon_unreachable
	// instead of user_opted_out — the user asked for them, we just
	// couldn't deliver. Task #3 swaps fetchWorkspaces to actually
	// hit /api/workspaces/bundle-all.
	IncludeWorkspaces bool

	// DaemonURL is the base URL the export will use for daemon HTTP
	// calls. Ignored in this iteration (no HTTP). Task #3 honors it.
	DaemonURL string

	// OutputDir is where the final zip is written. Empty → ~/Downloads.
	// If the chosen directory is not writable, the export falls back
	// to os.TempDir() and records the skip in the manifest.
	OutputDir string

	// ProgressFn, if non-nil, is invoked with phase strings as the
	// export progresses. Phases this iteration emits: "logs",
	// "packaging". Task #3 inserts "workspaces" between them when
	// IncludeWorkspaces is true.
	ProgressFn func(phase string)
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
	defer os.Remove(tmpPath)

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
	f, err := os.Create(tmpPath)
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
	logNames, err := addLogs(zw, sourceLogsDir())
	if err != nil {
		return err
	}

	stateIncluded, err := addStateJSON(zw, filepath.Join(sourceStateDir(), "state.json"))
	if err != nil {
		return err
	}

	pidsIncluded, err := addPids(zw, filepath.Join(sourceStateDir(), "pids"))
	if err != nil {
		return err
	}

	progress(opts.ProgressFn, "packaging")

	m := buildManifest(opts, logNames, stateIncluded, pidsIncluded, outDirSkipped)
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

// buildManifest assembles the manifest struct from the inputs that
// writeBundle gathered. The skip-reason logic lives here so it's one
// place to grep when tokens change.
func buildManifest(opts ExportOptions, logs []string, stateIncluded, pidsIncluded, outDirSkipped bool) manifest {
	skipped := []manifestSkip{}
	if opts.IncludeWorkspaces {
		// User asked, we couldn't deliver (no HTTP yet). Task #3
		// replaces this with the real fetch + its own skip reasons.
		skipped = append(skipped, manifestSkip{
			What: "workspaces",
			Why:  skipReasonDaemonUnreachable,
		})
	} else {
		skipped = append(skipped, manifestSkip{
			What: "workspaces",
			Why:  skipReasonUserOptedOut,
		})
	}
	if outDirSkipped {
		skipped = append(skipped, manifestSkip{
			What: "output_dir",
			Why:  skipReasonDownloadsUnwritable,
		})
	}
	return manifest{
		DaemonVersion:              getDaemonVersion(opts),
		OS:                         runtime.GOOS,
		Arch:                       runtime.GOARCH,
		GeneratedAt:                nowFn(),
		IncludeWorkspacesRequested: opts.IncludeWorkspaces,
		Included: manifestIncluded{
			Logs:       logs,
			StateJSON:  stateIncluded,
			Pids:       pidsIncluded,
			Workspaces: false,
		},
		Skipped: skipped,
	}
}

// getDaemonVersion is the seam task #3 swaps to actually call
// /api/version. Today it always returns the unreachable literal —
// the same value a real connect-refused would produce, so swapping
// the body doesn't change the public manifest format.
func getDaemonVersion(_ ExportOptions) string {
	return daemonVersionUnreachable
}

// addLogs copies every live .log file from logsDir into zw's logs/
// subdir. "Live" = filename ends in exactly .log (no .gz, no .log.N).
// Returns the sorted list of basenames included (for the manifest).
func addLogs(zw *zip.Writer, logsDir string) ([]string, error) {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read logs dir: %w", err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".log") {
			continue
		}
		if err := addFileFromDisk(zw, filepath.Join(logsDir, name), "logs/"+name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func addStateJSON(zw *zip.Writer, path string) (bool, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("stat state.json: %w", err)
	}
	if err := addFileFromDisk(zw, path, "state.json"); err != nil {
		return false, err
	}
	return true, nil
}

// addPids copies every entry from pidsDir into zw's pids/ subdir.
// Returns true iff the directory existed (regardless of how many
// files were inside — an empty pids/ still counts as "present").
func addPids(zw *zip.Writer, pidsDir string) (bool, error) {
	entries, err := os.ReadDir(pidsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read pids dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if err := addFileFromDisk(zw, filepath.Join(pidsDir, name), "pids/"+name); err != nil {
			return false, err
		}
	}
	return true, nil
}

func addFileFromDisk(zw *zip.Writer, srcPath, zipName string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", srcPath, err)
	}
	defer src.Close()
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
	probe.Close()
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
