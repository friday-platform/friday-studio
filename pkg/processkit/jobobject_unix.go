//go:build !windows

package processkit

// JobObject is a no-op on Unix. macOS doesn't have an equivalent of
// the Windows Job Object's KILL_ON_JOB_CLOSE behavior — children are
// reparented to launchd/init when the parent dies. Callers should
// rely on SweepOrphans on next startup to reap stale survivors.
type JobObject struct{}

// AttachSelfToJob always succeeds with a nil-safe stub on Unix.
func AttachSelfToJob() (*JobObject, error) { return &JobObject{}, nil }

// Close is a no-op on Unix.
func (j *JobObject) Close() error { return nil }
