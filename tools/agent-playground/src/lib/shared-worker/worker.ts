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

/**
 * Active per-turn chat fetches. Keyed by turnId so a stop-button abort
 * from the page can find the right `AbortController`. Streams write
 * chunks back to the originating `port` until the body completes or
 * the page sends `chat-turn-abort`.
 */
const chatTurns = new Map<string, { controller: AbortController; port: MessagePort }>();

async function handleChatTurnOpen(
  port: MessagePort,
  msg: Extract<ClientMessage, { type: "chat-turn-open" }>,
): Promise<void> {
  const { turnId, init } = msg;
  const controller = new AbortController();
  chatTurns.set(turnId, { controller, port });

  try {
    const response = await fetch(init.url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      credentials: init.credentials,
      signal: controller.signal,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    port.postMessage({
      type: "chat-turn-response",
      turnId,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    } satisfies WorkerMessage);

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Transfer the underlying buffer — zero-copy across the
        // worker→page boundary. The SDK's SSE parser on main reads
        // these chunks as bytes.
        const slice = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        port.postMessage(
          {
            type: "chat-turn-chunk",
            turnId,
            chunk: slice,
          } satisfies WorkerMessage,
          [slice],
        );
      }
    }
    port.postMessage({ type: "chat-turn-end", turnId } satisfies WorkerMessage);
  } catch (error) {
    // AbortError from `controller.abort()` is the page-driven cancel
    // path — surface it as an error so the transport's AbortSignal
    // contract is honored end-to-end.
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "fetch failed";
    port.postMessage({
      type: "chat-turn-error",
      turnId,
      error: message,
    } satisfies WorkerMessage);
  } finally {
    chatTurns.delete(turnId);
  }
}

function handleChatTurnAbort(msg: Extract<ClientMessage, { type: "chat-turn-abort" }>): void {
  const entry = chatTurns.get(msg.turnId);
  if (entry) entry.controller.abort();
}

function handleMessage(port: MessagePort, msg: ClientMessage): void {
  if (msg.type === "subscribe") handleSubscribe(port, msg);
  else if (msg.type === "unsubscribe") handleUnsubscribe(msg);
  else if (msg.type === "chat-turn-open") void handleChatTurnOpen(port, msg);
  else if (msg.type === "chat-turn-abort") handleChatTurnAbort(msg);
}

function dropPort(port: MessagePort): void {
  for (const [id, entry] of subscriptions) {
    if (entry.port === port) subscriptions.delete(id);
  }
  // Tab gone → cancel any in-flight chat turns that were writing to it.
  // Otherwise the fetch keeps streaming bytes into a closed port until
  // the daemon finishes the turn.
  for (const [id, entry] of chatTurns) {
    if (entry.port === port) {
      entry.controller.abort();
      chatTurns.delete(id);
    }
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
