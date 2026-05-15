//go:build windows

package main

// raiseFileLimit is a no-op on Windows. Windows uses per-process
// HANDLEs (≈16M cap, far beyond anything Friday touches) instead of
// the POSIX file-descriptor table that RLIMIT_NOFILE governs, so
// there's nothing to raise. Stays defined so main.go can call it
// unconditionally without a build-tagged call site.
func raiseFileLimit() {}
