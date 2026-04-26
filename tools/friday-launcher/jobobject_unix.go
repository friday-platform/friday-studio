//go:build !windows

package main

// jobObject is a no-op on Unix. macOS doesn't have an equivalent of
// the Windows Job Object's KILL_ON_JOB_CLOSE behavior — children are
// reparented to launchd/init when the parent dies. The orphan-cleanup
// pass on next launcher startup (cleanupOrphanedChildren) handles
// stale survivors instead.
type jobObject struct{}

func attachSelfToJob() (*jobObject, error) { return &jobObject{}, nil }
func (j *jobObject) Close() error          { return nil }
