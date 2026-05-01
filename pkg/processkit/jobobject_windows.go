//go:build windows

package processkit

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// JobObject wraps a Win32 Job Object configured with KILL_ON_JOB_CLOSE.
// Callers assign their OWN process to the job at startup; child
// processes spawned via os/exec inherit the job by default. When the
// parent process exits — gracefully OR via TerminateProcess — the
// kernel kills every job member.
type JobObject struct {
	handle windows.Handle
}

// AttachSelfToJob creates a Job Object and assigns the calling
// process to it. Returns the job (must be kept open for the lifetime
// of the process; closing it terminates all members).
func AttachSelfToJob() (*JobObject, error) {
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

	return &JobObject{handle: h}, nil
}

// Close releases the Job Object handle. Doing so kills every member
// process (including the caller, if it didn't fork-and-detach), so this
// should typically only be called as part of process shutdown.
func (j *JobObject) Close() error {
	if j == nil || j.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(j.handle)
	j.handle = 0
	return err
}
