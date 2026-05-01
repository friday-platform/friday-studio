//go:build windows

package main

import (
	"errors"
	"fmt"
	"unsafe"

	gopty "github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/windows"
)

// jobObject wraps a Win32 Job Object configured with KILL_ON_JOB_CLOSE.
// When the handle is released (Close), every process assigned to the job
// is terminated. Matches Unix SIGHUP-on-session-close semantics so
// closing the WS kills the entire descendant tree (Q2 resolution).
type jobObject struct {
	handle windows.Handle
}

func attachJobObject(cmd *gopty.Cmd) (*jobObject, error) {
	if cmd == nil || cmd.Process == nil {
		return nil, errors.New("nil cmd/process")
	}
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create job object: %w", err)
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		h,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("set job object info: %w", err)
	}

	procH, err := windows.OpenProcess(
		windows.PROCESS_TERMINATE|windows.PROCESS_SET_QUOTA,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(procH)
	if err := windows.AssignProcessToJobObject(h, procH); err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("assign to job: %w", err)
	}

	return &jobObject{handle: h}, nil
}

// Close releases the job handle, terminating every assigned process.
func (j *jobObject) Close() error {
	if j == nil || j.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(j.handle)
	j.handle = 0
	return err
}
