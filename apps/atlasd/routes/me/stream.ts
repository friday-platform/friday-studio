/**
 * `GET /api/me/stream` — single per-user SSE that collapses every
 * live event the daemon emits into one wire connection.
 *
 * Replaces the per-feed routes (`elicitations/stream`,
 * `instance/events?stream`, `events?stream`, …) at the protocol level:
 * the playground's SharedWorker holds one of these per browser and
 * fans out by frame `kind` to subscribers via MessagePort. Daemon-
 * side fanout collapses from `tabs × feeds` to `1` per browser.
 *
 * Frame shape (discriminated union over `kind`):
 *
 *   data: {"kind":"elicitation","workspaceId":"<wsid>","subject":"…","payload":{…}}
 *   data: {"kind":"workspace-event","workspaceId":"<wsid>","subject":"…","payload":{…}}
 *   data: {"kind":"instance","subject":"…","payload":{…}}
 *
 * `payload` is the JSON published to NATS, unmodified. Consumers
 * parse it against the channel-specific Zod schema (e.g.
 * `ElicitationSchema`) on the worker side.
 *
 * Authz: per-event filter against the user's accessible-workspaces
 * set. Initial set is a prefix-scan of `WORKSPACE_MEMBERS` keyed
 * `<userId>.<wsId>`. A KV watch on that same prefix runs for the
 * connection's lifetime — membership adds and removals propagate
 * live, no reconnect required. Events whose subject implies a
 * workspaceId not in the set are dropped before reaching the wire.
 *
 * Heartbeat: `: keepalive\n\n` every 15s so intermediate proxies
 * don't time the connection out. SSE comments (`:` prefix) are
 * ignored by `EventSource`.
 *
 * NATS gotcha: `nc.subscribe(...)` returns before the broker has
 * registered the subscription. The endpoint flushes once after
 * setting up all subs so the SSE handshake honestly means "from now
 * on you get every event." See
 * `~/.claude/skills/developing-with-nats` "Gotchas" — subscribe-
 * then-flush.
 */

import { daemonFactory } from "../../src/factory.ts";
import { openAccessibleWorkspaceWatch } from "../../src/workspace-authz.ts";

/** Subjects the user-firehose subscribes to. Order doesn't matter. */
const SUBJECTS = [
  // `elicitations.<wsId>.<sessId>.<id>` — pending tool / question prompts.
  "elicitations.>",
  // `events.<wsId>.<...>` — workspace-scoped lifecycle, schedule.missed,
  // health.degraded, etc.
  "events.>",
  // `instance.<type>.<...>` — daemon-wide cascade / queue-timeout /
  // replace events. Not workspace-scoped; every authenticated user
  // sees the same wire.
  "instance.>",
] as const;

interface ParsedFrame {
  kind: "elicitation" | "workspace-event" | "instance";
  workspaceId: string | undefined;
  subject: string;
  payload: unknown;
}

/**
 * Map a NATS subject onto a frame `kind` + extracted `workspaceId`.
 * The tokenization rules:
 *
 * - `elicitations.<wsId>.…` → kind=elicitation, workspaceId=tokens[1]
 * - `events.<wsId>.…`       → kind=workspace-event, workspaceId=tokens[1]
 * - `instance.…`            → kind=instance, no workspaceId
 *
 * Returns `null` for subjects that don't match any pattern (defensive
 * — the daemon only subscribes to the patterns above, so this branch
 * never fires in practice).
 */
function classify(subject: string, payload: unknown): ParsedFrame | null {
  const tokens = subject.split(".");
  const head = tokens[0];
  if (head === "elicitations" && tokens.length >= 2) {
    return { kind: "elicitation", workspaceId: tokens[1], subject, payload };
  }
  if (head === "events" && tokens.length >= 2) {
    return { kind: "workspace-event", workspaceId: tokens[1], subject, payload };
  }
  if (head === "instance") {
    return { kind: "instance", workspaceId: undefined, subject, payload };
  }
  return null;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const enc = new TextEncoder();

export const meStreamRoutes = daemonFactory.createApp().get("/stream", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const ctx = c.get("app");
  const nc = ctx.daemon.getNatsConnection();
  if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

  // Accessible-workspaces set, fused snapshot-and-watch in one
  // subscription. The returned set is fully populated by the time
  // this resolves and keeps mutating live as membership rows are
  // added/removed during the connection's lifetime — no reconnect
  // required to see a newly-shared workspace.
  const { accessible, stop: stopMembershipWatch } = await openAccessibleWorkspaceWatch(nc, userId);

  // Subscribe to every subject under one connection — one subscription
  // object per subject pattern, sharing the daemon's NATS connection.
  // The subs Map keeps the unsubscribe handles for teardown.
  const subs = SUBJECTS.map((subject) => ({ subject, sub: nc.subscribe(subject) }));
  // Subscribe-then-flush: see file-level docstring.
  await nc.flush();

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const teardown = () => {
        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        for (const { sub } of subs) {
          try {
            sub.unsubscribe();
          } catch {
            // already gone
          }
        }
        void stopMembershipWatch();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      c.req.raw.signal.addEventListener("abort", teardown);

      // Heartbeat — SSE comment line so EventSource ignores it, but
      // intermediate proxies see traffic and don't idle-close.
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`));
        } catch {
          // Controller closed mid-tick. Teardown handles cleanup; the
          // abort listener will fire and clean up the interval.
        }
      }, HEARTBEAT_INTERVAL_MS);

      const writeFrame = (frame: ParsedFrame): boolean => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
          return true;
        } catch {
          return false;
        }
      };

      for (const { sub } of subs) {
        void (async () => {
          try {
            for await (const msg of sub) {
              let payload: unknown;
              try {
                payload = JSON.parse(msg.string());
              } catch {
                // Drop non-JSON frames — every producer the daemon
                // owns publishes JSON. Surface via warn would be too
                // noisy in steady-state.
                continue;
              }
              const frame = classify(msg.subject, payload);
              if (!frame) continue;
              // Per-event authz: drop workspace-scoped frames whose
              // workspaceId isn't in the user's accessible set.
              if (frame.workspaceId !== undefined && !accessible.has(frame.workspaceId)) {
                continue;
              }
              if (!writeFrame(frame)) {
                // Stream closed mid-write — stop pumping; the abort
                // listener handles the rest.
                return;
              }
            }
          } catch {
            // for-await exited early. Abort listener / teardown
            // catches the rest.
          }
        })();
      }
    },
    async cancel() {
      // The browser closed the SSE connection; signal will have fired
      // already, but defense-in-depth.
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      for (const { sub } of subs) {
        try {
          sub.unsubscribe();
        } catch {
          // already gone
        }
      }
      // Await here so the underlying JetStream consumer is fully torn
      // down before the response promise settles — prevents transient
      // accumulation on rapid reconnect cycles. The abort-listener
      // teardown path (above) intentionally remains fire-and-forget
      // since addEventListener swallows the return value anyway.
      await stopMembershipWatch();
    },
  });

  return c.body(body, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
});
