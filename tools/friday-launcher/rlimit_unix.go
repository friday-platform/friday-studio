//go:build !windows

package main

import "syscall"

// targetFileLimit is the soft RLIMIT_NOFILE we try to raise to at
// launcher boot. 65536 is ~256x the macOS default soft limit (256 for
// processes launched via launchd / LaunchServices / `open`) and well
// below the kern.maxfilesperproc kernel ceiling (default 245760 on
// modern macOS). Leaves enough headroom for the friday daemon to
// supervise 5 services, hold a NATS connection, run cron timers, and
// keep spawning per-workspace MCP children across multi-day uptime.
//
// Why bump it here in the launcher (not inside friday itself): every
// supervised child inherits the launcher's rlimits via fork(), so one
// setrlimit at launcher boot covers the whole supervised tree without
// plumbing the value through each spawn site. Incident 2026-05-14:
// after ~49h uptime, friday hit "Too many open files (os error 24)"
// spawning a Snowflake MCP server, which silently broke a daily
// flash-report job — the analyst agent fell back on stale memory and
// kept emailing a 3-day-old report.
const targetFileLimit = 65536

// fallbackFileLimit is the older-macOS-friendly cap. macOS 10.7..10.11
// clamped the unprivileged setrlimit ceiling at OPEN_MAX (10240); on
// those builds a target of 65536 returns EINVAL. The retry path uses
// this so we still get a meaningful bump (~40x the 256 default) where
// we can't go higher.
const fallbackFileLimit = 10240

// raiseFileLimit raises the soft RLIMIT_NOFILE toward targetFileLimit,
// falling back to fallbackFileLimit if the kernel rejects the higher
// value. Non-fatal: a failed raise just puts us back on the historical
// "works until it doesn't" cliff. Logged once per boot.
func raiseFileLimit() {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		log.Warn("getrlimit RLIMIT_NOFILE failed; FD cap unchanged",
			"error", err)
		return
	}
	oldSoft := rl.Cur

	// Modern macOS reports rl.Max as RLIM_INFINITY (a very large
	// number); the rl.Max cap only really binds on Linux hosts where
	// the operator has set `ulimit -Hn`. Either way, never try to
	// raise above the hard cap.
	for _, want := range []uint64{targetFileLimit, fallbackFileLimit} {
		target := want
		if rl.Max != 0 && target > rl.Max {
			target = rl.Max
		}
		if rl.Cur >= target {
			log.Info("RLIMIT_NOFILE already adequate; no change",
				"soft", rl.Cur, "hard", rl.Max,
				"target", targetFileLimit)
			return
		}
		attempt := rl
		attempt.Cur = target
		if err := syscall.Setrlimit(
			syscall.RLIMIT_NOFILE, &attempt); err == nil {
			log.Info("raised RLIMIT_NOFILE",
				"old_soft", oldSoft, "new_soft", target,
				"hard", rl.Max)
			return
		}
	}
	log.Warn("setrlimit RLIMIT_NOFILE failed at every tier; "+
		"FD cap unchanged",
		"soft", oldSoft, "hard", rl.Max,
		"tried_target", targetFileLimit,
		"tried_fallback", fallbackFileLimit)
}
