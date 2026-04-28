package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/friday-platform/friday-studio/pkg/processkit"
)

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
	if err := removeIfExists(statePath()); err != nil {
		step("remove state.json", err)
	} else {
		step("state.json removed", nil)
	}

	if err := os.RemoveAll(pidsDir()); err != nil {
		step("remove pids/ directory", err)
	} else {
		step("pids/ directory removed", nil)
	}

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
//	connection refused / EOF / 4xx / 5xx / >5s read timeout → error
//	202 Accepted                                            → nil
//	409 Conflict (already shutting down)                    → nil
//
// Returns nil iff the launcher accepted the request and the
// caller should poll launcher.pid for removal. Any error means
// "fall through to SIGTERM".
func httpShutdownLauncher() error {
	url := "http://" + resolveHealthServerAddr() + "/api/launcher-shutdown"
	client := &http.Client{
		// Total timeout for the POST itself (header read + body
		// drain). The launcher's handler returns 202/409 in microseconds
		// — anything slower means the handler is hung. 5s gives us
		// plenty of headroom.
		Timeout: 5 * time.Second,
	}
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return fmt.Errorf("build POST: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		// Connection refused / EOF / DNS error / TLS error →
		// classify as "endpoint unavailable, fall back".
		var opErr *net.OpError
		switch {
		case errors.As(err, &opErr):
			return fmt.Errorf("connect: %w", err)
		case strings.Contains(err.Error(), "connection refused"):
			return fmt.Errorf("connection refused")
		case strings.Contains(err.Error(), "deadline exceeded"):
			return fmt.Errorf("post timeout")
		default:
			return fmt.Errorf("post: %w", err)
		}
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

func removeIfExists(path string) error {
	err := os.Remove(path)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return err
}
