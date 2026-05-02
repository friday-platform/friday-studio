/**
 * Per-job promise scheduler that enforces the workspace.yml concurrency
 * policies (G2.2 reinforcement).
 *
 * - `serialize(jobName, maxQueued, fn)` — chains the runner onto a per-job
 *   promise. Each new caller awaits the previous chain head; at most one
 *   in flight per job. `maxQueued` bounds pending depth (throws on
 *   overflow).
 * - `coalesce(jobName, fn)` — if the job is idle, runs `fn` immediately
 *   as the new chain head. If the job is already running, `fn` becomes
 *   the *pending slot* — and any subsequent coalesce calls during the
 *   active run replace the slot, so a burst of triggers collapses to
 *   "current run completes, then one more run with the latest fn."
 *
 * `singleton` policy maps to `serialize` for in-process semantics; cross-
 * process advisory locking is a future addition (cluster mode).
 */
export class JobScheduler<T> {
  private chains = new Map<string, Promise<unknown>>();
  private queueLengths = new Map<string, number>();
  private coalesceLatest = new Map<string, () => Promise<T>>();
  private coalesceWaiters = new Map<
    string,
    Array<{ resolve: (s: T) => void; reject: (e: unknown) => void }>
  >();

  serialize(jobName: string, maxQueued: number | undefined, fn: () => Promise<T>): Promise<T> {
    const pending = this.queueLengths.get(jobName) ?? 0;
    if (maxQueued !== undefined && pending >= maxQueued) {
      throw new Error(`Queue full for job '${jobName}' (max_queued=${maxQueued})`);
    }
    this.queueLengths.set(jobName, pending + 1);

    // Decrement inside the runner's finally so callers can immediately
    // serialize again after their await resolves — without this the
    // queue-length cleanup runs on a later microtask and the next caller
    // sees stale depth.
    const fnWithCleanup = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        const remaining = (this.queueLengths.get(jobName) ?? 1) - 1;
        if (remaining <= 0) {
          this.queueLengths.delete(jobName);
        } else {
          this.queueLengths.set(jobName, remaining);
        }
      }
    };

    const prev = this.chains.get(jobName) ?? Promise.resolve();
    const next = prev.then(fnWithCleanup, fnWithCleanup);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(jobName, tracked);
    tracked.finally(() => {
      if (this.chains.get(jobName) === tracked) {
        this.chains.delete(jobName);
      }
    });
    return next;
  }

  coalesce(jobName: string, fn: () => Promise<T>): Promise<T> {
    if (!this.chains.has(jobName)) {
      // Idle — run as the new chain head; on completion drain whatever
      // accumulated in the slot during this run.
      return this.startChainHead(jobName, fn);
    }

    // Already running — install / replace the pending slot. Return a
    // promise resolved when the slot eventually fires.
    this.coalesceLatest.set(jobName, fn);
    return new Promise<T>((resolve, reject) => {
      const waiters = this.coalesceWaiters.get(jobName) ?? [];
      waiters.push({ resolve, reject });
      this.coalesceWaiters.set(jobName, waiters);
    });
  }

  private startChainHead(jobName: string, fn: () => Promise<T>): Promise<T> {
    const runner = (async () => {
      try {
        return await fn();
      } finally {
        this.drainCoalesceSlot(jobName);
      }
    })();
    const tracked = runner.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(jobName, tracked);
    tracked.finally(() => {
      if (this.chains.get(jobName) === tracked) {
        this.chains.delete(jobName);
      }
    });
    return runner;
  }

  /** When the chain head finishes, run whatever ended up in the slot. */
  private drainCoalesceSlot(jobName: string): void {
    const fn = this.coalesceLatest.get(jobName);
    if (!fn) return;
    const waiters = this.coalesceWaiters.get(jobName) ?? [];
    this.coalesceLatest.delete(jobName);
    this.coalesceWaiters.delete(jobName);

    const runner = (async () => {
      try {
        const result = await fn();
        for (const w of waiters) w.resolve(result);
      } catch (err) {
        for (const w of waiters) w.reject(err);
      } finally {
        // Recursive drain — if more callers piled into the slot during
        // this run, fire the latest of them too.
        this.drainCoalesceSlot(jobName);
      }
    })();
    const tracked = runner.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(jobName, tracked);
    tracked.finally(() => {
      if (this.chains.get(jobName) === tracked) {
        this.chains.delete(jobName);
      }
    });
  }

  /** Reject all pending coalesce waiters and forget all chains. Call from runtime shutdown. */
  shutdown(reason: string = "shutting down"): void {
    for (const waiters of this.coalesceWaiters.values()) {
      for (const w of waiters) {
        w.reject(new Error(reason));
      }
    }
    this.coalesceLatest.clear();
    this.coalesceWaiters.clear();
    this.chains.clear();
    this.queueLengths.clear();
  }
}
