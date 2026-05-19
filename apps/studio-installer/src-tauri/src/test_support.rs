// Shared test-only helpers. Anything that mutates process state — env
// vars, the working dir, signal handlers — needs a process-wide lock,
// because cargo runs tests in parallel within a single binary and the
// state being mutated is shared across every thread.
//
// `env_lock()` is the lock for tests that touch FRIDAY_LAUNCHER_HOME /
// HOME. Both `friday_home::tests` and
// `commands::env_file::apply_platform_vars_tests` use it. Previously
// each module declared its own private `OnceLock<Mutex<()>>` and the
// two locks didn't coordinate — tests in module A could race tests in
// module B mutating the same env var. Centralising here closes that
// race.

use std::sync::{Mutex, MutexGuard, OnceLock};

/// Process-wide lock for tests that mutate env vars touched by
/// `friday_home::friday_home_dir()` (FRIDAY_LAUNCHER_HOME, HOME).
///
/// Recovers from poisoning on purpose: a poisoned lock here means a
/// prior test panicked mid-assertion. Subsequent tests should still
/// run — `into_inner()` gives them the guard so they can proceed and
/// reset the env to a known state via their own RAII guards.
pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
