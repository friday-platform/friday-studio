/**
 * N6: process-wide registry of "ensure-state" reset callbacks. JetStream
 * adapters (artifacts, elicitations, mcp-registry, session-history, …)
 * cache `streamEnsured` / `cachedKv` flags so the cost of provisioning
 * a stream/bucket is paid once per process. Without invalidation, a NATS
 * server restart leaves those flags stuck at `true`/non-null, and the
 * first publish after the bounce fails with `stream-not-found` /
 * `bucket-not-found`. Adapters register their reset callback here at
 * construction; this module subscribes once to the connection's status
 * iterator and fans out a reset on every reconnect.
 *
 * Cheap insurance — common in tests (the test fixture stops/starts a
 * nats-server) and not unheard of in production (broker upgrade, OS
 * patch, network blip long enough for the JS client to declare
 * disconnect-then-reconnect). Pre-N6 the only mitigation was to throw
 * away the connection and recreate every adapter; post-N6 it's a
 * one-line opt-in per adapter.
 */

import type { NatsConnection } from "nats";

const subscribedConnections = new WeakSet<NatsConnection>();
const callbacksByConnection = new WeakMap<NatsConnection, Set<() => void>>();

/**
 * Register a reset callback to fire on the next NATS reconnect. Returns
 * an unregister function — call it when the adapter is torn down so the
 * weak-map slot can shrink. Idempotent w.r.t. duplicate (nc, fn) pairs.
 *
 * The status subscription is started lazily on first registration per
 * connection. Callbacks are invoked sequentially with a try/catch around
 * each so one misbehaving adapter doesn't block the others.
 */
export function registerReconnectReset(nc: NatsConnection, reset: () => void): () => void {
  let callbacks = callbacksByConnection.get(nc);
  if (!callbacks) {
    callbacks = new Set();
    callbacksByConnection.set(nc, callbacks);
  }
  callbacks.add(reset);

  if (!subscribedConnections.has(nc)) {
    subscribedConnections.add(nc);
    void watchReconnects(nc);
  }

  return () => {
    callbacks?.delete(reset);
  };
}

async function watchReconnects(nc: NatsConnection): Promise<void> {
  try {
    for await (const status of nc.status()) {
      if (status.type !== "reconnect") continue;
      const cbs = callbacksByConnection.get(nc);
      if (!cbs) return;
      for (const cb of cbs) {
        try {
          cb();
        } catch {
          // Per-adapter reset failures must not block the others; the
          // adapter will hit a fresh ensureStream on next access regardless.
        }
      }
    }
  } catch {
    // The status iterator throws when the connection is permanently
    // closed. Nothing to do — once closed, no further reconnects can fire.
  }
}
