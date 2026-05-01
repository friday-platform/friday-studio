// Package processkit provides cross-platform helpers for managing
// child processes from Go binaries: graceful kill with SIGTERM→SIGKILL
// escalation on Unix, taskkill on Windows; Windows Job Object setup
// with KILL_ON_JOB_CLOSE so children die with the parent; orphan-pid
// sweep on startup; per-platform SysProcAttr setup so SIGTERM
// propagates via process group.
//
// Used by tools/friday-launcher and tools/webhook-tunnel.
package processkit
