package processkit

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestSweepOrphansEmptyDir(t *testing.T) {
	tmp := t.TempDir()
	killed, err := SweepOrphans(tmp)
	if err != nil {
		t.Fatalf("unexpected error on empty dir: %v", err)
	}
	if killed != 0 {
		t.Fatalf("expected 0 killed, got %d", killed)
	}
}

func TestSweepOrphansMissingDir(t *testing.T) {
	// nonexistent dir → 0 killed, nil error (first-run case)
	killed, err := SweepOrphans(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("expected nil error for missing dir, got %v", err)
	}
	if killed != 0 {
		t.Fatalf("expected 0 killed, got %d", killed)
	}
}

func TestSweepOrphansSkipsLauncherPid(t *testing.T) {
	tmp := t.TempDir()
	// Write a launcher.pid pointing at our own pid — sweep must NOT
	// kill us.
	self := os.Getpid()
	content := strconv.Itoa(self) + " 1234567890\n"
	if err := os.WriteFile(filepath.Join(tmp, "launcher.pid"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	killed, err := SweepOrphans(tmp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if killed != 0 {
		t.Fatalf("expected launcher.pid skipped, got %d killed", killed)
	}
	// File should still exist (sweep skipped it entirely).
	if _, err := os.Stat(filepath.Join(tmp, "launcher.pid")); err != nil {
		t.Fatalf("launcher.pid was removed by sweep: %v", err)
	}
}

func TestSweepOrphansRemovesMalformed(t *testing.T) {
	tmp := t.TempDir()
	bad := filepath.Join(tmp, "broken.pid")
	if err := os.WriteFile(bad, []byte("not a pid file"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _ = SweepOrphans(tmp)
	if _, err := os.Stat(bad); !os.IsNotExist(err) {
		t.Fatalf("expected malformed pid file removed; stat err=%v", err)
	}
}

func TestSweepOrphansKillsLiveChild(t *testing.T) {
	tmp := t.TempDir()
	// Spawn a sleep child we can verify gets killed. Reap via Wait
	// goroutine so ProcessAlive returns false once it actually exits
	// (zombies still satisfy kill -0).
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	go func() { _ = cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	pid := cmd.Process.Pid
	content := strconv.Itoa(pid) + " 0\n"
	if err := os.WriteFile(filepath.Join(tmp, "child.pid"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	killed, err := SweepOrphans(tmp)
	if err != nil {
		t.Fatalf("sweep error: %v", err)
	}
	if killed != 1 {
		t.Fatalf("expected 1 killed, got %d", killed)
	}

	// Wait briefly for the kernel to deliver SIGTERM.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("child %d still alive after sweep", pid)
}

func TestParsePidFile(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantPID int
		wantErr bool
	}{
		{"valid", "12345 1700000000", 12345, false},
		{"trailing newline", "999 0\n", 999, false},
		{"single field", "12345", 0, true},
		{"three fields", "1 2 3", 0, true},
		{"non-numeric pid", "abc 0", 0, true},
		{"non-numeric start", "1 abc", 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pid, _, err := ParsePidFile([]byte(c.input))
			if c.wantErr {
				if err == nil {
					t.Errorf("expected error, got pid=%d", pid)
				}
				return
			}
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if pid != c.wantPID {
				t.Errorf("pid: want %d, got %d", c.wantPID, pid)
			}
		})
	}
}
