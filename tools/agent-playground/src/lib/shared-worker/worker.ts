/**
 * SharedWorker — one per browser, holds the single upstream
 * `EventSource("/api/daemon/api/me/stream")` and fans out frames over
 * MessagePorts. Replaces the per-tab, per-feed `new EventSource(...)`
 * sprawl that exhausted HTTP/1.1 connection pools when many tabs were
 * open against the same daemon.
 *
 * Fanout model: each tab opens the worker via `new SharedWorker(...)`,
 * gets a MessagePort, and posts `{type: "subscribe", subscriptionId,
 * params}` messages. The worker maintains a map of subscriptionId →
 * `{port, params}` and pushes each upstream frame that matches the
 * params to that port's `{type: "frame"}` message.
 *
 * Why one map keyed by subscriptionId rather than per-port lists: a
 * single tab can have multiple subscriptions on different channels
 * (e.g. cascade banner + global elicitations + workspace elicitations
 * for the focused workspace). Each gets its own id so unsubscribe is
 * surgical.
 *
 * Upstream lifecycle: the EventSource opens on first subscription and
 * closes when the last subscription is gone. Reconnect is delegated to
 * EventSource's built-in retry. Connection state is broadcast as
 * `{type: "upstream"}` so the page can render a degraded indicator.
 *
 * @module
 */

/// <reference lib="webworker" />

import { matches } from "./filters.ts";
import type { ClientMessage, SubscribeParams, UpstreamFrame, WorkerMessage } from "./protocol.ts";

declare const self: SharedWorkerGlobalScope;

interface Subscription {
  id: string;
  port: MessagePort;
  params: SubscribeParams;
}

const subscriptions = new Map<string, Subscription>();
let upstream: EventSource | undefined;
let upstreamState: "open" | "closed" = "closed";

function ensureUpstream(): void {
  if (upstream) return;
  upstream = new EventSource("/api/daemon/api/me/stream");
  upstream.addEventListener("open", () => {
    upstreamState = "open";
    broadcast({ type: "upstream", state: "open" });
  });
  upstream.addEventListener("error", () => {
    // EventSource auto-reconnects on transient errors. State here is a
    // hint to the page that the firehose is currently degraded —
    // wrappers can render a stale-data badge if they want.
    if (upstreamState === "open") {
      upstreamState = "closed";
      broadcast({ type: "upstream", state: "closed" });
    }
  });
  upstream.addEventListener("message", (event: MessageEvent<string>) => {
    let frame: UpstreamFrame;
    try {
      frame = JSON.parse(event.data) as UpstreamFrame;
    } catch {
      return;
    }
    dispatch(frame);
  });
}

function maybeCloseUpstream(): void {
  if (subscriptions.size === 0 && upstream) {
    upstream.close();
    upstream = undefined;
    upstreamState = "closed";
  }
}

function dispatch(frame: UpstreamFrame): void {
  for (const entry of subscriptions.values()) {
    if (!matches(frame, entry.params)) continue;
    const msg: WorkerMessage = {
      type: "frame",
      subscriptionId: entry.id,
      payload: frame.payload,
    };
    try {
      entry.port.postMessage(msg);
    } catch {
      // Port closed mid-dispatch — disconnect handler will reap it.
    }
  }
}

function broadcast(msg: WorkerMessage): void {
  const seen = new Set<MessagePort>();
  for (const { port } of subscriptions.values()) {
    if (seen.has(port)) continue;
    seen.add(port);
    try {
      port.postMessage(msg);
    } catch {
      // already closed
    }
  }
}

function handleSubscribe(
  port: MessagePort,
  msg: Extract<ClientMessage, { type: "subscribe" }>,
): void {
  subscriptions.set(msg.subscriptionId, { id: msg.subscriptionId, port, params: msg.params });
  ensureUpstream();
  // Replay current upstream state to the new subscriber so a
  // late-joining tab can render its degraded badge correctly.
  try {
    port.postMessage({ type: "upstream", state: upstreamState } satisfies WorkerMessage);
  } catch {
    // already closed
  }
}

function handleUnsubscribe(msg: Extract<ClientMessage, { type: "unsubscribe" }>): void {
  subscriptions.delete(msg.subscriptionId);
  maybeCloseUpstream();
}

function handleMessage(port: MessagePort, msg: ClientMessage): void {
  if (msg.type === "subscribe") handleSubscribe(port, msg);
  else if (msg.type === "unsubscribe") handleUnsubscribe(msg);
}

function dropPort(port: MessagePort): void {
  for (const [id, entry] of subscriptions) {
    if (entry.port === port) subscriptions.delete(id);
  }
  maybeCloseUpstream();
}

self.addEventListener("connect", (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  port.addEventListener("message", (e: MessageEvent<ClientMessage>) => {
    handleMessage(port, e.data);
  });
  // MessagePort needs explicit start when using addEventListener instead
  // of onmessage — otherwise no messages are delivered.
  port.start();
  port.addEventListener("messageerror", () => dropPort(port));
});
