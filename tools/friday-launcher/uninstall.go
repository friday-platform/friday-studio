package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/friday-platform/friday-studio/pkg/processkit"
)

// httpShutdownTimeout caps the POST to /api/launcher-shutdown.
// The launcher's handler returns 202/409 in microseconds; anything
// slower means the handler is hung. Test-only override hook so
// timeout-fallback tests don't have to wait the full 5 seconds.
var httpShutdownTimeout = 5 * time.Second

// runUninstall removes Friday Launcher's OS-level footprint:
//  1. Stop the running launcher. Try `POST /api/launcher-shutdown`
//     first (Decision #9 + #10); fall back to SIGTERM-and-poll if
//     the HTTP call doesn't indicate a clean shutdown is in
//     progress (connection refused, 4xx/5xx, timeout — see
//     v15 § Caller response-handling table).
//  2. ALWAYS run `processkit.SweepByBinaryPath(binDir)` after
//     step 1 — catches orphans whose parent died externally and
//     never got a chance to run its own sweep. This is the
//     2026-04-27 bug v9 hadn't fixed yet: with the launcher
//     already dead but its children alive, the previous code
//     reported success and left the orphans running.
//  3. Remove the OS autostart entry (LaunchAgent plist on macOS,
//     HKCU registry value on Windows).
//  4. Remove pids/ + state.json. Logs are kept by default.
//
// Idempotent — re-running after a previous --uninstall is safe.
// Exits 0 on success, 1 on any error.
func runUninstall() {
	stepFailed := false
	step := func(name string, err error) {
		if err == nil {
			fmt.Printf("  ✓ %s\n", name)
			return
		}
		fmt.Printf("  ✗ %s: %s\n", name, err)
		stepFailed = true
	}

	fmt.Println("friday-launcher uninstall:")

	// 1. Stop the running launcher. Try HTTP first; fall back to
	//    SIGTERM-and-poll on any non-clean response.
	stopRunningLauncher(step)

	// 2. Always sweep, even if step 1 reported "already stopped" —
	//    a dead launcher's orphan children show up exactly there.
	if killed, err := processkit.SweepByBinaryPath(binDir); err != nil {
		step("sweep orphan supervised processes", err)
	} else if killed > 0 {
		step(fmt.Sprintf("swept %d orphan supervised processes", killed), nil)
	} else {
		step("no orphan supervised processes", nil)
	}

	// 3. Remove autostart entry.
	if err := disableAutostart(); err != nil {
		step("remove autostart entry", err)
	} else {
		step("autostart entry removed", nil)
	}

	// 4. Remove pids/ + state.json. Logs are preserved.
	// os.RemoveAll handles ENOENT silently — same idiom for both.
	//
	// State removal happens BEFORE .app bundle removal: if .app
	// removal fails (permission denied on /Applications when the
	// bundle was sudo-installed by an admin), we still want
	// state.json + pids/ cleared so a subsequent re-install or
	// `--uninstall` retry starts from a known-clean home dir.
	// The .app sitting in /Applications without state is recoverable
	// (Spotlight finds it; user can drag-to-trash); state.json
	// referencing a vanished .app is more confusing.
	if err := os.RemoveAll(statePath()); err != nil {
		step("remove state.json", err)
	} else {
		step("state.json removed", nil)
	}

	if err := os.RemoveAll(pidsDir()); err != nil {
		step("remove pids/ directory", err)
	} else {
		step("pids/ directory removed", nil)
	}

	// 5. Remove the .app bundle from /Applications (Stack 3,
	// darwin-only). Last step so a permission failure on
	// /Applications doesn't leave state.json + pids/ in place
	// (see comment on step 4 ordering). The launcher is currently
	// running from inside the bundle; the OS holds the executable
	// open until our process exits, so we can RM the surrounding
	// directory now — the kernel reference-counts the deleted inode
	// and our exec stays valid until exit.
	removeAppBundleIfPresent(step)

	fmt.Println()
	fmt.Printf("Logs preserved at: %s\n", logsDir())
	if stepFailed {
		os.Exit(1)
	}
}

// stopRunningLauncher tries graceful shutdown via HTTP first,
// SIGTERM as fallback. Both paths poll launcher.pid for up to 35s
// before giving up; the sweep step that follows runUninstall
// catches anything left running.
func stopRunningLauncher(step func(string, error)) {
	pid, err := readLauncherPid()
	pidExists := err == nil && pid > 0 && processkit.ProcessAlive(pid)

	if !pidExists {
		step("launcher already stopped", nil)
		return
	}

	// HTTP path. Per the response table (v15 § cross-cutting):
	//   - 202 / 409 → poll launcher.pid for removal up to 35s
	//   - everything else → fall through to SIGTERM-and-poll
	if err := httpShutdownLauncher(); err == nil {
		fmt.Printf("  · launcher accepted HTTP shutdown\n")
		if waitForLauncherExit(pid, 35*time.Second) {
			step("launcher stopped (HTTP)", nil)
			return
		}
		step("launcher process exit", fmt.Errorf(
			"pid %d still alive after 35s post HTTP shutdown; "+
				"remaining cleanup may race", pid))
		return
	} else {
		fmt.Printf("  · HTTP shutdown unavailable (%s), "+
			"falling back to SIGTERM\n", err)
	}

	// SIGTERM fallback.
	fmt.Printf("  · stopping running launcher pid=%d (SIGTERM)\n", pid)
	_ = processkit.Kill(pid, 0)
	if waitForLauncherExit(pid, 35*time.Second) {
		step("launcher process stopped (SIGTERM)", nil)
		return
	}
	step("launcher process exit", fmt.Errorf(
		"pid %d still alive after 35s; remaining cleanup may race", pid))
}

// healthServerAddrOverride is the test-only override for the
// otherwise-const healthServerAddr. uninstall.go's HTTP client
// reads through resolveHealthServerAddr() so production traffic
// always hits 127.0.0.1:5199 while tests can point at an
// httptest.Server on a random port.
var healthServerAddrOverride string

// resolveHealthServerAddr returns the addr the uninstall HTTP
// client should target. Production uses the const; tests override
// via healthServerAddrOverride.
func resolveHealthServerAddr() string {
	if healthServerAddrOverride != "" {
		return healthServerAddrOverride
	}
	return healthServerAddr
}

// httpShutdownLauncher POSTs to /api/launcher-shutdown and
// interprets the response per the v15 § Caller response-handling
// table:
//
//	connection refused / EOF / 4xx / 5xx / timeout → error (caller falls back to SIGTERM)
//	202 Accepted                                   → nil
//	409 Conflict (already shutting down)           → nil
//
// All transport errors (connect / EOF / DNS / TLS / deadline) and
// all non-2xx/4xx-409 statuses funnel into "fall back to SIGTERM",
// so we don't bother classifying — the caller treats every non-nil
// error identically.
func httpShutdownLauncher() error {
	url := "http://" + resolveHealthServerAddr() + "/api/launcher-shutdown"
	client := &http.Client{Timeout: httpShutdownTimeout}
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return fmt.Errorf("build POST: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	// Drain body so the connection can be reused (or properly
	// closed). Bounded read so a misbehaving launcher can't make
	// us read forever.
	_, _ = io.CopyN(io.Discard, resp.Body, 4096)

	switch resp.StatusCode {
	case http.StatusAccepted, http.StatusConflict:
		return nil
	default:
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
}

// waitForLauncherExit polls launcher.pid for removal AND the pid
// itself for ESRCH. Returns true if the launcher process is gone
// before deadline, false if still alive at timeout.
//
// Polling cadence is 100ms — fast enough to give "just finished"
// shutdowns sub-200ms feedback, slow enough not to spin.
func waitForLauncherExit(pid int, deadline time.Duration) bool {
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		if !processkit.ProcessAlive(pid) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// removeAppBundleIfPresent deletes /Applications/Friday Studio.app
// on darwin (and is a no-op on other platforms). Best-effort: the
// .app may not exist (devs running flat builds, or installers that
// don't land it in /Applications), so absence is reported as a
// noop step rather than a failure.
//
// Safety: the launcher's own executable lives inside the bundle.
// Removing the bundle from disk while we're running is safe — the
// kernel reference-counts the open inode, our exec stays valid
// until process exit. Same trick Sparkle uses.
func removeAppBundleIfPresent(step func(string, error)) {
	path := appBundlePath()
	if path == "" {
		// Non-darwin or otherwise no-op platform.
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			step("no .app bundle to remove", nil)
			return
		}
		step("stat "+path, err)
		return
	}
	if !info.IsDir() {
		// Something else at that path — don't touch it. Surface
		// for the operator's attention rather than blindly rm.
		step(fmt.Sprintf("%s is not a directory; skipping", path), nil)
		return
	}
	if err := os.RemoveAll(path); err != nil {
		step("remove "+path, err)
		return
	}
	step(".app bundle removed from /Applications", nil)
}
