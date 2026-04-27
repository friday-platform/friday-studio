//go:build !windows

package processkit

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

// startReaped starts cmd and spawns a goroutine that calls Wait so the
// child doesn't become a zombie. Without reaping, syscall.Kill(pid, 0)
// returns success on a dead-but-unwaited process — making ProcessAlive
// useless for verifying actual termination.
func startReaped(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	go func() { _ = cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
}

func TestKillSigtermOnly(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	startReaped(t, cmd)
	pid := cmd.Process.Pid

	if err := Kill(pid, 0); err != nil {
		t.Fatalf("Kill returned error: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("pid %d still alive after Kill(pid, 0)", pid)
}

func TestKillEscalatesToSigkill(t *testing.T) {
	// Trap SIGTERM in a shell so we can verify the SIGKILL escalation.
	cmd := exec.Command("sh", "-c", `trap "" TERM; sleep 30`)
	startReaped(t, cmd)
	pid := cmd.Process.Pid
	// Make sure trap is in place.
	time.Sleep(150 * time.Millisecond)

	start := time.Now()
	if err := Kill(pid, 500*time.Millisecond); err != nil {
		t.Fatalf("Kill returned error: %v", err)
	}
	elapsed := time.Since(start)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			if elapsed < 400*time.Millisecond {
				t.Errorf("escalated too fast: %v < 400ms grace", elapsed)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("pid %d still alive after Kill with grace", pid)
}

func TestKillNonexistentPid(t *testing.T) {
	if err := Kill(99999, 0); err != nil {
		t.Fatalf("Kill on missing pid should be nil, got %v", err)
	}
}

func TestProcessAliveSelf(t *testing.T) {
	if !ProcessAlive(os.Getpid()) {
		t.Fatalf("ProcessAlive(self) returned false")
	}
}
