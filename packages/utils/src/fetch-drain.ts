/**
 * Drain a Response body that the caller is about to discard.
 *
 * Why: every `fetch()` returns a Response whose body is a `ReadableStream`
 * backed by a borrowed socket from hyper's keep-alive pool. The socket only
 * returns to the pool once the body is fully consumed OR explicitly cancelled.
 * Code that early-returns on `!res.ok` without doing either holds the socket
 * in "borrowed" state — hyper then has to open a *new* socket for the next
 * request because the old one isn't reusable.
 *
 * Under sustained concurrency (chat workloads, agent execution, retry loops
 * on credential refresh) the pool grows without bound and the daemon
 * eventually trips EMFILE. Manu's 2026-05-14 incident — friday daemon hit
 * "Too many open files (os error 24)" on a localhost fetch to `link` after
 * ~49h of uptime — is the canonical example.
 *
 * Call this on every code path that takes a Response and decides not to read
 * the body. The `.catch(() => {})` swallows "stream already disturbed"
 * errors so the helper is safe to call from defensive `if (!res.ok)`
 * branches that might race with body consumers in upper layers (it would
 * almost never happen in our codebase but the catch is cheap insurance).
 *
 * Idiomatic use:
 *
 *   const res = await fetch(url);
 *   if (!res.ok) {
 *     await discardBody(res);
 *     return null;
 *   }
 */
export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Body was already consumed / locked / cancelled — nothing to do.
  }
}
