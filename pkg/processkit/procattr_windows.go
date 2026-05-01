//go:build windows

package processkit

import (
	"os/exec"
	"syscall"
)

// SetSysProcAttr configures cmd to start in a new Windows process
// group (CREATE_NEW_PROCESS_GROUP) so callers can send CTRL_BREAK_EVENT
// to the group without affecting the parent. Call before cmd.Start().
//
// Note: KILL_ON_JOB_CLOSE on a Job Object (see AttachSelfToJob) is a
// stronger guarantee — the Job Object handles the "child dies with
// parent" semantics. Setting CREATE_NEW_PROCESS_GROUP here is mainly
// for callers that need to send group signals explicitly.
func SetSysProcAttr(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windowsCreateNewProcessGroup
}

// CREATE_NEW_PROCESS_GROUP literal — keeps the file from importing
// golang.org/x/sys/windows just for the constant.
const windowsCreateNewProcessGroup = 0x00000200
