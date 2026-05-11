/**
 * `fetch`-shaped wrapper that routes the chat turn through the
 * SharedWorker. The worker holds the SSE socket; this returns a
 * `Response` backed by a worker-fed `ReadableStream<Uint8Array>` so
 * the AI SDK's parser on main reads chunks the same way it would
 * from a direct fetch.
 *
 * What this moves off the main thread:
 * - Underlying socket lifetime (open / read / close in the worker
 *   event loop)
 * - HTTP framing + byte buffering up to chunk arrival
 *
 * What stays on main:
 * - SSE line splitting + `JSON.parse` per chunk
 * - Zod validation of each `UIMessageChunk`
 * - Merge into the chat's `messages` state and Svelte reactivity
 *
 * Why only the socket moves: cursor tracking for resume
 * (`Last-Event-ID`) lives in `createCursorTrackingFetch`, which reads
 * `id:` lines from the body on main. Moving SSE parsing to the worker
 * would mean either moving cursor tracking too or duplicating the SSE
 * state machine across the boundary. This iteration isolates socket
 * lifecycle from the UI thread without that fork.
 *
 * Drop-in via `createCursorTrackingFetch({ fetchImpl: workerFetch })`.
 *
 * @module
 */

import type { ChatTurnInit, ClientMessage, WorkerMessage } from "../shared-worker/protocol.ts";

interface PendingTurn {
  /** Pull-controller for the response-body stream we hand to the SDK. */
  controller?: ReadableStreamDefaultController<Uint8Array>;
  /** Resolves once the worker's `chat-turn-response` lands. */
  resolveResponse: (response: Response) => void;
  /** Rejects the outer `fetch()` promise on transport failure. */
  rejectResponse: (error: Error) => void;
  /** True once `chat-turn-response` has fired — body chunks expected from here on. */
  responseReceived: boolean;
}

const turns = new Map<string, PendingTurn>();

/**
 * Lazily-opened SharedWorker shared with the firehose subscriber. The
 * worker code in `worker.ts` handles both the `/api/me/stream`
 * upstream and the per-turn chat fetches; one process, one port per
 * tab.
 */
let workerPort: MessagePort | undefined;

function getWorkerPort(): MessagePort {
  if (workerPort) return workerPort;
  if (typeof SharedWorker === "undefined") {
    throw new Error("SharedWorker not available");
  }
  const worker = new SharedWorker(new URL("../shared-worker/worker.ts", import.meta.url), {
    type: "module",
    name: "friday-me-stream",
  });
  worker.port.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    handleWorkerMessage(event.data);
  });
  worker.port.start();
  workerPort = worker.port;
  return worker.port;
}

function handleWorkerMessage(msg: WorkerMessage): void {
  if (msg.type === "chat-turn-response") {
    const turn = turns.get(msg.turnId);
    if (!turn) return;
    turn.responseReceived = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        turn.controller = controller;
      },
    });
    const response = new Response(stream, {
      status: msg.status,
      statusText: msg.statusText,
      headers: new Headers(msg.headers),
    });
    turn.resolveResponse(response);
    return;
  }
  if (msg.type === "chat-turn-chunk") {
    const turn = turns.get(msg.turnId);
    if (!turn?.controller) return;
    turn.controller.enqueue(new Uint8Array(msg.chunk));
    return;
  }
  if (msg.type === "chat-turn-end") {
    const turn = turns.get(msg.turnId);
    if (!turn) return;
    turn.controller?.close();
    turns.delete(msg.turnId);
    return;
  }
  if (msg.type === "chat-turn-error") {
    const turn = turns.get(msg.turnId);
    if (!turn) return;
    const err = new Error(msg.error);
    if (turn.responseReceived) {
      turn.controller?.error(err);
    } else {
      turn.rejectResponse(err);
    }
    turns.delete(msg.turnId);
  }
}

/**
 * `fetch`-shaped function that proxies to the SharedWorker. Pass as
 * `fetchImpl` to `createCursorTrackingFetch` so the tracking wrapper
 * keeps reading cursors from the response on main, while the actual
 * socket lives in the worker.
 *
 * Falls back to native `fetch` when `SharedWorker` is unavailable
 * (SSR, vitest happy-dom, ancient browsers).
 */
export function createWorkerFetch(): typeof fetch {
  if (typeof SharedWorker === "undefined") {
    return fetch;
  }
  return async function workerFetch(input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body == null
          ? ""
          : await new Response(init.body as BodyInit).text();
    const credentials = init?.credentials;

    const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const port = getWorkerPort();

    const responsePromise = new Promise<Response>((resolve, reject) => {
      turns.set(turnId, {
        resolveResponse: resolve,
        rejectResponse: reject,
        responseReceived: false,
      });
    });

    const turnInit: ChatTurnInit = { url, method, headers, body, credentials };
    port.postMessage({ type: "chat-turn-open", turnId, init: turnInit } satisfies ClientMessage);

    if (init?.signal) {
      const onAbort = () => {
        port.postMessage({ type: "chat-turn-abort", turnId } satisfies ClientMessage);
        const turn = turns.get(turnId);
        if (turn) {
          const abortError = new DOMException("Aborted", "AbortError");
          if (turn.responseReceived) {
            try {
              turn.controller?.error(abortError);
            } catch {
              // already closed
            }
          } else {
            turn.rejectResponse(abortError);
          }
          turns.delete(turnId);
        }
      };
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener("abort", onAbort, { once: true });
    }

    return responsePromise;
  };
}
