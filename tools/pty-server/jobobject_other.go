//go:build !windows

package main

import gopty "github.com/aymanbagabas/go-pty"

// jobObject is a no-op on non-Windows platforms. PTY teardown on Unix
// uses SIGHUP via the slave-end close, which already kills the session.
type jobObject struct{}

func (*jobObject) Close() error { return nil }

func attachJobObject(_ *gopty.Cmd) (*jobObject, error) { return nil, nil }
