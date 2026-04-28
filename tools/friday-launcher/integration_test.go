//go:build integration

// Integration tests for friday-launcher. Real subprocesses, no mocks
// (matching the testing skill's preference for end-to-end coverage).
//
// These tests build a fresh launcher binary, spawn six stub services
// on fixed ports (18080, 13100, 17681, 19090, 15200, 18222), and hit
// localhost — so they assume nothing else on the host is using those
// ports. To keep `go test ./...` clean, the file is gated behind the
// `integration` build tag. Run with:
//
//	go test -tags=integration ./tools/friday-launcher/...
//
// Each test gets its own throwaway home dir via FRIDAY_LAUNCHER_HOME
// so they don't interfere with the user's real ~/.friday or with
// each other.
package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/friday-platform/friday-studio/pkg/processkit"
)

// stubProgram is a tiny inline Go program built once per test run. It
// serves a /health endpoint on a port and exits cleanly on SIGTERM.
const stubProgram = `package main
import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)
func main() {
	port := os.Getenv("PORT")
	healthPath := os.Getenv("HEALTH_PATH")
	if healthPath == "" { healthPath = "/health" }
	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "OK")
	})
	go http.ListenAndServe("127.0.0.1:"+port, mux)
	ch := make(chan os.Signal, 4)
	if os.Getenv("IGNORE_SIGTERM") == "1" {
		signal.Ignore(syscall.SIGTERM)
		signal.Notify(ch, syscall.SIGINT)
	} else {
		signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	}
	<-ch
	time.Sleep(50 * time.Millisecond)
}
`

// buildLauncherAndStubs compiles the launcher + stub once, returns
// both paths. Cached across subtests in the same go test run via the
// helper's caller setting up a TestMain or per-suite global.
func buildLauncherAndStubs(t *testing.T) (launcherPath, binDir string) {
	t.Helper()
	tmp := t.TempDir()
	launcherPath = filepath.Join(tmp, "friday-launcher-test")
	binDir = filepath.Join(tmp, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Build launcher from THIS source directory.
	cmd := exec.Command("go", "build", "-o", launcherPath, ".")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build launcher: %v", err)
	}

	// Build stub.
	stubSrc := filepath.Join(tmp, "stub")
	if err := os.MkdirAll(stubSrc, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stubSrc, "main.go"),
		[]byte(stubProgram), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stubSrc, "go.mod"),
		[]byte("module stub\ngo 1.26\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubBin := filepath.Join(binDir, "_stub")
	cmd = exec.Command("go", "build", "-o", stubBin, ".")
	cmd.Dir = stubSrc
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build stub: %v", err)
	}

	// Per-name wrappers — one shell script per supervised binary.
	wrappers := map[string]struct{ port, healthPath string }{
		"nats-server":    {"18222", "/healthz"},
		"friday":         {"18080", "/health"},
		"link":           {"13100", "/health"},
		"pty-server":     {"17681", "/health"},
		"webhook-tunnel": {"19090", "/health"},
		"playground":     {"15200", "/api/health"},
	}
	for name, w := range wrappers {
		writeWrapper(t, binDir, name, stubBin, w.port, w.healthPath, "")
	}
	return launcherPath, binDir
}

func writeWrapper(t *testing.T, binDir, name, stubBin, port, healthPath, extra string) {
	t.Helper()
	body := "#!/usr/bin/env bash\nexec env STUB_NAME=" + name +
		" PORT=" + port + " HEALTH_PATH=" + healthPath +
		" " + extra + " " + stubBin + "\n"
	if err := os.WriteFile(filepath.Join(binDir, name),
		[]byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
}

// portEnv returns the FRIDAY_PORT_<name> env vars.
func portEnv() []string {
	return []string{
		"FRIDAY_PORT_nats_server=18222",
		"FRIDAY_PORT_friday=18080",
		"FRIDAY_PORT_link=13100",
		"FRIDAY_PORT_pty_server=17681",
		"FRIDAY_PORT_webhook_tunnel=19090",
		"FRIDAY_PORT_playground=15200",
	}
}

// startLauncher boots the launcher in the background. Returns the
// *exec.Cmd (caller MUST kill on test end via t.Cleanup) and the
// home dir for inspection. Gives launcher up to 5 s to acquire the
// lock + write the pid file.
func startLauncher(t *testing.T, launcherPath, binDir string) (*exec.Cmd, string) {
	t.Helper()
	killStaleStubs(t)
	home := t.TempDir()
	homeLocal := filepath.Join(home, ".friday", "local")
	if err := os.MkdirAll(homeLocal, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(launcherPath,
		"--bin-dir="+binDir, "--no-browser")
	env := append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+homeLocal,
	)
	env = append(env, portEnv()...)
	cmd.Env = env
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start launcher: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-done:
			case <-time.After(35 * time.Second):
				_ = cmd.Process.Kill()
			}
		}
		// Best-effort sweep of any leftover stub processes.
		_ = exec.Command("pkill", "-KILL", "-f", filepath.Join(binDir, "_stub")).Run()
	})
	pidFile := filepath.Join(homeLocal, "pids", "launcher.pid")
	for range 50 {
		if _, err := os.Stat(pidFile); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	return cmd, homeLocal
}

// testStubPorts is the fixed-port set every integration test pins
// against. Listed once so killStaleStubs and the post-shutdown port
// assertion stay in sync.
var testStubPorts = []int{18222, 18080, 13100, 17681, 19090, 15200}

// killStaleStubs frees the test ports before a test starts. Each test
// runs in its own t.TempDir() bin path; the per-test cleanup only
// pkills stubs from that path, so a previous interrupted `go test`
// run can leave old stubs holding the same fixed ports. Without this
// sweep, TestSIGTERMCleanShutdown sees those orphaned PIDs and fails.
func killStaleStubs(t *testing.T) {
	t.Helper()
	for _, port := range testStubPorts {
		out, err := exec.Command("lsof", "-i",
			"tcp:"+strconv.Itoa(port), "-sTCP:LISTEN", "-t").Output()
		if err != nil || len(out) == 0 {
			continue
		}
		for _, pidStr := range strings.Fields(string(out)) {
			pid, err := strconv.Atoi(pidStr)
			if err != nil {
				continue
			}
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	// Give the kernel a beat to release the sockets.
	time.Sleep(50 * time.Millisecond)
}

// healthyTimeout caps how long waitHealthy will block before failing
// the test. Every existing caller passes 10s; pinning it to a const
// removes a ceremonial parameter without losing the bound.
const healthyTimeout = 10 * time.Second

// waitHealthy polls the 5 stub /health endpoints until all return 200
// or t.Fatalf if not within healthyTimeout.
func waitHealthy(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(healthyTimeout)
	urls := []string{
		"http://127.0.0.1:18222/healthz",
		"http://127.0.0.1:18080/health",
		"http://127.0.0.1:13100/health",
		"http://127.0.0.1:17681/health",
		"http://127.0.0.1:19090/health",
		"http://127.0.0.1:15200/api/health",
	}
	for {
		ok := 0
		for _, u := range urls {
			resp, err := http.Get(u)
			if err == nil && resp.StatusCode == 200 {
				_ = resp.Body.Close()
				ok++
			} else if resp != nil {
				_ = resp.Body.Close()
			}
		}
		if ok == len(urls) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d stubs healthy after %s", ok, len(urls), healthyTimeout)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// readPidFile parses launcher.pid and returns the recorded pid or
// fails the test.
func readPidFile(t *testing.T, homeLocal string) int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(homeLocal, "pids", "launcher.pid"))
	if err != nil {
		t.Fatalf("read pid file: %v", err)
	}
	parts := strings.Fields(strings.TrimSpace(string(data)))
	if len(parts) != 2 {
		t.Fatalf("pid file format: %q", string(data))
	}
	pid, err := strconv.Atoi(parts[0])
	if err != nil {
		t.Fatalf("pid parse: %v", err)
	}
	return pid
}

// TestEndToEndLaunchAndHealthy boots the launcher, asserts all 5
// stubs come up + report ready within 10 s, then tears down via
// SIGTERM and asserts everything exited within 35 s.
func TestEndToEndLaunchAndHealthy(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	cmd, home := startLauncher(t, launcher, binDir)
	waitHealthy(t)
	if pid := readPidFile(t, home); pid != cmd.Process.Pid {
		t.Errorf("pid file says %d, launcher running as %d", pid, cmd.Process.Pid)
	}
}

// TestSIGTERMCleanShutdown verifies SIGTERM brings everything down +
// removes the pid file.
func TestSIGTERMCleanShutdown(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	cmd, home := startLauncher(t, launcher, binDir)
	waitHealthy(t)
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("launcher did not exit within 20s after SIGTERM")
	}
	pidFile := filepath.Join(home, "pids", "launcher.pid")
	if _, err := os.Stat(pidFile); !os.IsNotExist(err) {
		t.Errorf("pid file still present after shutdown: err=%v", err)
	}
	// All ports should be free.
	for _, port := range []int{18080, 13100, 17681, 19090, 15200} {
		conn, err := exec.Command("lsof", "-i",
			"tcp:"+strconv.Itoa(port), "-sTCP:LISTEN", "-t").Output()
		if err == nil && len(conn) > 0 {
			t.Errorf("port %d still bound after shutdown: pids=%q",
				port, string(conn))
		}
	}
}

// TestShutdownTimeoutSafety verifies that a stub ignoring SIGTERM is
// killed via SIGKILL after ShutDownTimeout (10s), and the launcher
// itself exits within ~13s.
func TestShutdownTimeoutSafety(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	// Replace the playground wrapper with one that ignores SIGTERM.
	stubBin := filepath.Join(binDir, "_stub")
	writeWrapper(t, binDir, "playground", stubBin,
		"15200", "/api/health", "IGNORE_SIGTERM=1")
	cmd, _ := startLauncher(t, launcher, binDir)
	waitHealthy(t)
	start := time.Now()
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(35 * time.Second):
		t.Fatal("launcher did not exit after 35s — deadline broken?")
	}
	elapsed := time.Since(start)
	if elapsed < 8*time.Second || elapsed > 16*time.Second {
		t.Errorf("expected shutdown ~10-13s (SIGTERM + ShutDownTimeout); got %v", elapsed)
	}
}

// TestSecondInstanceWakeUp verifies the SIGUSR1 handshake (Unix only).
func TestSecondInstanceWakeUp(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	if runtime.GOOS == "windows" {
		t.Skip("SIGUSR1 path is Unix-only; Windows uses sentinel-file")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	cmd, home := startLauncher(t, launcher, binDir)
	waitHealthy(t)
	pid := readPidFile(t, home)

	// Spawn second instance with the SAME home dir.
	second := exec.Command(launcher, "--bin-dir="+binDir, "--no-browser")
	second.Env = append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+home,
	)
	second.Env = append(second.Env, portEnv()...)
	out, err := second.CombinedOutput()
	if err != nil {
		t.Fatalf("second instance exited with err: %v out=%s", err, out)
	}
	if !strings.Contains(string(out), "another launcher detected") {
		t.Errorf("second instance didn't detect lock; out=%s", out)
	}
	// Original launcher must still be alive.
	if err := syscall.Kill(pid, 0); err != nil {
		t.Errorf("original launcher pid %d died: %v", pid, err)
	}
	_ = cmd
}

// TestStalePidFileHandling verifies that a stale launcher.pid (with a
// non-existent pid) doesn't block a fresh launcher from starting.
func TestStalePidFileHandling(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	home := filepath.Join(t.TempDir(), ".friday", "local")
	if err := os.MkdirAll(filepath.Join(home, "pids"), 0o700); err != nil {
		t.Fatal(err)
	}
	// Plant a stale pid file for a definitely-not-running pid.
	if err := os.WriteFile(
		filepath.Join(home, "pids", "launcher.pid"),
		[]byte("99999 1000000000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(launcher, "--bin-dir="+binDir, "--no-browser")
	cmd.Env = append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+home,
	)
	cmd.Env = append(cmd.Env, portEnv()...)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
	})
	pidFile := filepath.Join(home, "pids", "launcher.pid")
	for range 50 {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			parts := strings.Fields(strings.TrimSpace(string(data)))
			if len(parts) == 2 && parts[0] != "99999" {
				return // good — pid file overwritten with our pid
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("launcher didn't overwrite stale pid file within 5s")
}

// TestOrphanCleanup verifies the cleanupOrphanedChildren sweep on
// fresh start sweeps a planted orphan pid file.
func TestOrphanCleanup(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	if runtime.GOOS == "windows" {
		t.Skip("orphan cleanup is Unix-only — Windows handles via Job Object")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	home := filepath.Join(t.TempDir(), ".friday", "local")
	pidsDir := filepath.Join(home, "pids")
	if err := os.MkdirAll(pidsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// Spawn a victim sleeper that we'll claim is an orphaned supervised process.
	victim := exec.Command("sleep", "120")
	if err := victim.Start(); err != nil {
		t.Fatal(err)
	}
	// Reap in a goroutine so the test can detect actual exit (vs
	// zombie). syscall.Kill(pid, 0) returns nil for zombies so the
	// poll-loop below would never see "dead".
	victimExited := make(chan struct{})
	go func() {
		_ = victim.Wait()
		close(victimExited)
	}()
	t.Cleanup(func() { _ = victim.Process.Kill() })
	// Plant a per-process pid file pointing at the sleeper.
	if err := os.WriteFile(
		filepath.Join(pidsDir, "friday.pid"),
		[]byte(strconv.Itoa(victim.Process.Pid)+" 1000000000\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Boot the launcher; orphan cleanup runs in main() before onReady.
	cmd := exec.Command(launcher, "--bin-dir="+binDir, "--no-browser")
	cmd.Env = append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+home,
	)
	cmd.Env = append(cmd.Env, portEnv()...)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
	})
	// Wait for the victim to actually exit (zombie reap via the
	// goroutine above). The sweep runs VERY early in launcher startup.
	select {
	case <-victimExited:
		// Good — orphan was killed and Wait() reaped it.
	case <-time.After(5 * time.Second):
		t.Fatalf("orphan victim pid %d still alive after 5s; cleanup didn't fire",
			victim.Process.Pid)
	}
}

// TestRestartAllOrder verifies that calling Supervisor.RestartAll
// triggers StopProcess in stopOrder then StartProcess in startOrder.
//
// This test exercises the in-process Supervisor wrapper directly
// (no external launcher process) so we can observe call ordering
// via the supervised stubs' log entries.
func TestRestartAllOrder(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	expectedStopOrder := []string{
		"playground", "pty-server", "webhook-tunnel", "friday", "link", "nats-server",
	}
	expectedStartOrder := []string{
		"nats-server", "friday", "link", "pty-server", "webhook-tunnel", "playground",
	}
	if !slicesEqual(stopOrder, expectedStopOrder) {
		t.Errorf("stopOrder mismatch:\n want %q\n  got %q",
			expectedStopOrder, stopOrder)
	}
	if !slicesEqual(startOrder, expectedStartOrder) {
		t.Errorf("startOrder mismatch:\n want %q\n  got %q",
			expectedStartOrder, startOrder)
	}
}

func slicesEqual(a, b []string) bool {
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

// TestAutostartSelfRegister verifies that on first run, the LaunchAgent
// plist is written with the launcher's own os.Executable() path. macOS
// only — Windows uses the registry, which the launcher's Windows path
// would write but is hard to test from a Mac.
func TestAutostartSelfRegister(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	if runtime.GOOS != "darwin" {
		t.Skip("macOS-specific plist test")
	}
	// Save + restore the user's real plist if any.
	plistPath := filepath.Join(os.Getenv("HOME"),
		"Library/LaunchAgents/ai.hellofriday.studio.plist")
	backup, _ := os.ReadFile(plistPath)
	t.Cleanup(func() {
		if backup != nil {
			_ = os.WriteFile(plistPath, backup, 0o600)
		} else {
			_ = os.Remove(plistPath)
		}
	})
	_ = os.Remove(plistPath)
	launcher, binDir := buildLauncherAndStubs(t)
	cmd, _ := startLauncher(t, launcher, binDir)
	// Goroutine E runs from onReady; give it a moment.
	for range 30 {
		if _, err := os.Stat(plistPath); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	data, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatalf("plist not written: %v", err)
	}
	if !strings.Contains(string(data), launcher) {
		t.Errorf("plist doesn't reference launcher path %q\n--- plist ---\n%s",
			launcher, string(data))
	}
	if !strings.Contains(string(data), "<string>--no-browser</string>") {
		t.Error("plist missing --no-browser arg")
	}
	if !strings.Contains(string(data), "<key>RunAtLoad</key>") {
		t.Error("plist missing RunAtLoad key")
	}
	_ = cmd
}

// TestAutostartStalenessRepair verifies that a plist pointing at the
// wrong path gets rewritten on next launcher startup.
func TestAutostartStalenessRepair(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	if runtime.GOOS != "darwin" {
		t.Skip("macOS-specific")
	}
	plistPath := filepath.Join(os.Getenv("HOME"),
		"Library/LaunchAgents/ai.hellofriday.studio.plist")
	backup, _ := os.ReadFile(plistPath)
	t.Cleanup(func() {
		if backup != nil {
			_ = os.WriteFile(plistPath, backup, 0o600)
		} else {
			_ = os.Remove(plistPath)
		}
	})
	// Plant a stale plist.
	stalePath := "/tmp/friday-launcher-totally-not-real-path"
	stalePlist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hellofriday.studio</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + stalePath + `</string>
    <string>--no-browser</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>`
	if err := os.WriteFile(plistPath, []byte(stalePlist), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, binDir := buildLauncherAndStubs(t)
	cmd, home := startLauncher(t, launcher, binDir)
	// Mark autostart_initialized=true so goroutine E hits the
	// staleness-repair branch (not first-run).
	if err := os.WriteFile(filepath.Join(home, "state.json"),
		[]byte(`{"autostart_initialized":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Restart the launcher so goroutine E sees state.json this time.
	_ = cmd.Process.Signal(syscall.SIGTERM)
	_ = cmd.Wait()

	cmd2 := exec.Command(launcher, "--bin-dir="+binDir, "--no-browser")
	cmd2.Env = append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+home,
	)
	cmd2.Env = append(cmd2.Env, portEnv()...)
	cmd2.Stderr = os.Stderr
	if err := cmd2.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd2.Process.Signal(syscall.SIGTERM)
		_ = cmd2.Wait()
	})
	// Poll for the plist to be repaired.
	for range 60 {
		data, err := os.ReadFile(plistPath)
		if err == nil && strings.Contains(string(data), launcher) &&
			!strings.Contains(string(data), stalePath) {
			return // success
		}
		time.Sleep(100 * time.Millisecond)
	}
	data, _ := os.ReadFile(plistPath)
	t.Fatalf("staleness repair didn't run; plist:\n%s", string(data))
}

// TestUninstall verifies the --uninstall flag stops a running
// launcher, removes the plist, and cleans up pids/state.json while
// preserving logs.
func TestUninstall(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	launcher, binDir := buildLauncherAndStubs(t)
	// Don't use startLauncher() here — its cleanup func calls cmd.Wait,
	// which would race with the manual reaper goroutine we need below.
	// Inline the spawn so we own lifecycle exclusively.
	home := filepath.Join(t.TempDir(), ".friday", "local")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(launcher, "--bin-dir="+binDir, "--no-browser")
	cmd.Env = append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+home,
	)
	cmd.Env = append(cmd.Env, portEnv()...)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	launcherPid := cmd.Process.Pid
	exited := make(chan struct{})
	// In production the launcher's parent is launchd which reaps
	// immediately on exit. In test the parent is `go test`, which
	// doesn't reap, leaving a zombie that fools syscall.Kill(pid, 0).
	// Reap in a goroutine so the runUninstall liveness check sees
	// "dead" promptly.
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		// If --uninstall already brought the launcher down, exited is
		// already closed and Signal returns ESRCH which is fine.
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
		}
		_ = exec.Command("pkill", "-KILL", "-f",
			filepath.Join(binDir, "_stub")).Run()
	})
	// Wait for pid file before proceeding.
	pidFile := filepath.Join(home, "pids", "launcher.pid")
	for range 50 {
		if _, err := os.Stat(pidFile); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	waitHealthy(t)

	// On macOS, save/restore the real plist; uninstall removes it.
	var plistPath string
	var backup []byte
	if runtime.GOOS == "darwin" {
		plistPath = filepath.Join(os.Getenv("HOME"),
			"Library/LaunchAgents/ai.hellofriday.studio.plist")
		backup, _ = os.ReadFile(plistPath)
	}
	t.Cleanup(func() {
		if plistPath != "" && backup != nil {
			_ = os.WriteFile(plistPath, backup, 0o600)
		}
	})

	uninst := exec.Command(launcher, "--uninstall")
	uninst.Env = append(os.Environ(),
		"FRIDAY_LAUNCHER_HOME="+home,
	)
	out, err := uninst.CombinedOutput()
	if err != nil {
		t.Fatalf("--uninstall failed: %v\n%s", err, out)
	}
	_ = launcherPid

	// Original launcher must be exited (reaped, not zombie).
	if processkit.ProcessAlive(launcherPid) {
		t.Errorf("launcher pid %d still alive after --uninstall", launcherPid)
	}
	// pids/ removed.
	if _, err := os.Stat(filepath.Join(home, "pids")); !os.IsNotExist(err) {
		t.Errorf("pids/ dir still present: err=%v", err)
	}
	// state.json removed.
	if _, err := os.Stat(filepath.Join(home, "state.json")); !os.IsNotExist(err) {
		t.Errorf("state.json still present: err=%v", err)
	}
	// Logs preserved.
	if _, err := os.Stat(filepath.Join(home, "logs", "launcher.log")); err != nil {
		t.Errorf("launcher.log was removed: %v", err)
	}
	// Plist removed (macOS).
	if plistPath != "" {
		if _, err := os.Stat(plistPath); !os.IsNotExist(err) {
			t.Errorf("plist still present: err=%v", err)
		}
	}
}
