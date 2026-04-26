//go:build windows

package main

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobObject wraps a Win32 Job Object configured with KILL_ON_JOB_CLOSE.
// We assign the LAUNCHER process itself to the job at startup; child
// processes spawned via os/exec inherit the job by default. When the
// launcher process exits — gracefully OR via TerminateProcess — the
// kernel kills every job member. Lifted from tools/pty-server/
// jobobject_windows.go (#3012).
type jobObject struct {
	handle windows.Handle
}

// attachSelfToJob creates a Job Object and assigns the launcher's
// own process to it. Returns the job handle (must be kept open for
// the lifetime of the launcher; closing it terminates all members).
func attachSelfToJob() (*jobObject, error) {
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

	selfH, err := windows.OpenProcess(
		windows.PROCESS_TERMINATE|windows.PROCESS_SET_QUOTA,
		false, uint32(os.Getpid()))
	if err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("open self process: %w", err)
	}
	defer windows.CloseHandle(selfH)
	if err := windows.AssignProcessToJobObject(h, selfH); err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("assign self to job: %w", err)
	}

	return &jobObject{handle: h}, nil
}

func (j *jobObject) Close() error {
	if j == nil || j.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(j.handle)
	j.handle = 0
	return err
}
