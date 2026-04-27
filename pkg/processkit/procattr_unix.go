//go:build !windows

package processkit

import (
	"os/exec"
	"syscall"
)

// SetSysProcAttr configures cmd so that SIGTERM to the parent
// propagates to the child via process group. Sets Setpgid=true
// (places the child in a new process group with PGID == child PID),
// which combined with the caller signaling the negative PGID kills
// the entire group cleanly. Call before cmd.Start().
//
// On Windows this is a no-op handled by the windows build tag.
func SetSysProcAttr(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}
