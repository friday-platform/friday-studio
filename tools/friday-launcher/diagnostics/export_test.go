package diagnostics

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// pinClock pins nowFn for golden / deterministic tests; restored on
// t.Cleanup. Returns the pinned time so callers can derive expected
// filenames from it.
func pinClock(t *testing.T, when time.Time) time.Time {
	t.Helper()
	prev := nowFn
	nowFn = func() time.Time { return when }
	t.Cleanup(func() { nowFn = prev })
	return when
}

// stubSources points the package-level dir resolvers at a temp tree.
// Each test gets a fresh tree so they can run in parallel without
// stomping each other.
func stubSources(t *testing.T) (logsDir, stateDir string) {
	t.Helper()
	home := t.TempDir()
	logsDir = filepath.Join(home, "logs")
	stateDir = home
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "pids"), 0o755); err != nil {
		t.Fatalf("mkdir pids: %v", err)
	}
	prevLogs, prevState := sourceLogsDir, sourceStateDir
	sourceLogsDir = func() string { return logsDir }
	sourceStateDir = func() string { return stateDir }
	t.Cleanup(func() {
		sourceLogsDir = prevLogs
		sourceStateDir = prevState
	})
	return logsDir, stateDir
}

// readZipEntries returns the names of every entry in a zip, sorted.
func readZipEntries(t *testing.T, path string) []string {
	t.Helper()
	r, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open zip %s: %v", path, err)
	}
	defer func() { _ = r.Close() }()
	names := make([]string, 0, len(r.File))
	for _, f := range r.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	return names
}

// readZipFile returns the body of a named entry inside a zip.
func readZipFile(t *testing.T, zipPath, entry string) []byte {
	t.Helper()
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	defer func() { _ = r.Close() }()
	for _, f := range r.File {
		if f.Name != entry {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open entry %s: %v", entry, err)
		}
		body, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read entry %s: %v", entry, err)
		}
		return body
	}
	t.Fatalf("entry %s not found in %s", entry, zipPath)
	return nil
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestExport_HappyPath_LogsOnly(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "daemon.log"), "hello\n")
	writeFile(t, filepath.Join(logs, "launcher.log"), "world\n")
	writeFile(t, filepath.Join(state, "state.json"), `{"autostart_initialized":true}`)
	writeFile(t, filepath.Join(state, "pids", "foo.pid"), "1234")

	out := t.TempDir()
	zipPath, err := Export(ExportOptions{OutputDir: out})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if !strings.HasPrefix(filepath.Base(zipPath), "friday-diagnostics-") || !strings.HasSuffix(zipPath, ".zip") {
		t.Errorf("unexpected zip path: %s", zipPath)
	}

	got := readZipEntries(t, zipPath)
	want := []string{
		"logs/daemon.log",
		"logs/launcher.log",
		"manifest.yml",
		"pids/foo.pid",
		"state.json",
	}
	if !equalStringSlices(got, want) {
		t.Errorf("zip entries mismatch.\n  got:  %v\n  want: %v", got, want)
	}

	// No .partial lingering after a successful export.
	entries, err := os.ReadDir(out)
	if err != nil {
		t.Fatalf("readdir out: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".partial") {
			t.Errorf("found leftover .partial: %s", e.Name())
		}
	}

	// Manifest sanity: workspaces opted out, state_json + pids true.
	mBytes := readZipFile(t, zipPath, "manifest.yml")
	mStr := string(mBytes)
	for _, needle := range []string{
		"include_workspaces_requested: false",
		"state_json: true",
		"pids: true",
		"workspaces: false",
		"why: user_opted_out",
		"daemon_version: unreachable",
	} {
		if !strings.Contains(mStr, needle) {
			t.Errorf("manifest missing %q\nfull body:\n%s", needle, mStr)
		}
	}
}

func TestExport_LogsFilter(t *testing.T) {
	logs, state := stubSources(t)
	for _, name := range []string{"daemon.log", "daemon.log.1.gz", "daemon.log.2", "agent.log"} {
		writeFile(t, filepath.Join(logs, name), "x")
	}
	writeFile(t, filepath.Join(state, "state.json"), "{}")

	out := t.TempDir()
	zipPath, err := Export(ExportOptions{OutputDir: out})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	var gotLogs []string
	for _, name := range readZipEntries(t, zipPath) {
		if strings.HasPrefix(name, "logs/") {
			gotLogs = append(gotLogs, name)
		}
	}
	sort.Strings(gotLogs)
	want := []string{"logs/agent.log", "logs/daemon.log"}
	if !equalStringSlices(gotLogs, want) {
		t.Errorf("logs filter mismatch.\n  got:  %v\n  want: %v", gotLogs, want)
	}
}

func TestExport_ProgressFn(t *testing.T) {
	t.Run("opt_out", func(t *testing.T) {
		logs, state := stubSources(t)
		writeFile(t, filepath.Join(logs, "a.log"), "x")
		writeFile(t, filepath.Join(state, "state.json"), "{}")

		var phases []string
		_, err := Export(ExportOptions{
			OutputDir:  t.TempDir(),
			ProgressFn: func(p string) { phases = append(phases, p) },
		})
		if err != nil {
			t.Fatalf("Export: %v", err)
		}
		want := []string{"logs", "packaging"}
		if !equalStringSlices(phases, want) {
			t.Errorf("phases = %v, want %v", phases, want)
		}
	})

	t.Run("include_workspaces_true", func(t *testing.T) {
		logs, state := stubSources(t)
		writeFile(t, filepath.Join(logs, "a.log"), "x")
		writeFile(t, filepath.Join(state, "state.json"), "{}")
		srv := newDaemonStub(t, daemonStub{})
		defer srv.Close()

		var phases []string
		_, err := Export(ExportOptions{
			IncludeWorkspaces: true,
			DaemonURL:         srv.URL,
			OutputDir:         t.TempDir(),
			ProgressFn:        func(p string) { phases = append(phases, p) },
		})
		if err != nil {
			t.Fatalf("Export: %v", err)
		}
		want := []string{"logs", "workspaces", "packaging"}
		if !equalStringSlices(phases, want) {
			t.Errorf("phases = %v, want %v", phases, want)
		}
	})
}

func TestExport_SkipReason_OptOutVsUnreachable(t *testing.T) {
	cases := []struct {
		name              string
		includeWorkspaces bool
		wantWhy           string
	}{
		{"opt_out", false, "user_opted_out"},
		{"include_no_http", true, "daemon_unreachable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logs, state := stubSources(t)
			writeFile(t, filepath.Join(logs, "a.log"), "x")
			writeFile(t, filepath.Join(state, "state.json"), "{}")

			zipPath, err := Export(ExportOptions{
				IncludeWorkspaces: tc.includeWorkspaces,
				OutputDir:         t.TempDir(),
			})
			if err != nil {
				t.Fatalf("Export: %v", err)
			}
			body := string(readZipFile(t, zipPath, "manifest.yml"))
			want := "why: " + tc.wantWhy
			if !strings.Contains(body, want) {
				t.Errorf("manifest missing %q\n%s", want, body)
			}
		})
	}
}

func TestExport_DownloadsFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod 0o500 doesn't enforce write-deny on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses unix mode bits; fallback unreachable")
	}

	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")

	readonly := t.TempDir()
	if err := os.Chmod(readonly, 0o500); err != nil {
		t.Fatalf("chmod readonly: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(readonly, 0o700) })

	zipPath, err := Export(ExportOptions{OutputDir: readonly})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if strings.HasPrefix(zipPath, readonly+string(os.PathSeparator)) {
		t.Errorf("zip landed in unwritable dir %s: %s", readonly, zipPath)
	}

	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "what: output_dir") || !strings.Contains(body, "why: downloads_unwritable") {
		t.Errorf("manifest missing output_dir/downloads_unwritable skip:\n%s", body)
	}
}

func TestExport_MissingStateJson(t *testing.T) {
	logs, _ := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	// Intentionally no state.json.

	zipPath, err := Export(ExportOptions{OutputDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	// state.json should not be in the zip when it doesn't exist on disk.
	for _, name := range readZipEntries(t, zipPath) {
		if name == "state.json" {
			t.Errorf("state.json present in zip despite missing on disk")
		}
	}
	body := string(readZipFile(t, zipPath, "manifest.yml"))
	if !strings.Contains(body, "state_json: false") {
		t.Errorf("expected state_json: false in manifest, got:\n%s", body)
	}
}

func TestExport_AtomicNoPartialOnSuccess(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")

	out := t.TempDir()
	_, err := Export(ExportOptions{OutputDir: out})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	entries, _ := os.ReadDir(out)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".partial") {
			t.Errorf("partial file left behind: %s", e.Name())
		}
	}
}

func TestExport_FilenameFormat(t *testing.T) {
	logs, state := stubSources(t)
	writeFile(t, filepath.Join(logs, "a.log"), "x")
	writeFile(t, filepath.Join(state, "state.json"), "{}")

	pinClock(t, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	zipPath, err := Export(ExportOptions{OutputDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	want := "friday-diagnostics-2026-01-02-030405.zip"
	if filepath.Base(zipPath) != want {
		t.Errorf("filename = %s, want %s", filepath.Base(zipPath), want)
	}
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
