import { ElicitationStorage } from "@atlas/core/elicitations";
import type { ToolContext } from "../types.ts";

const DEFAULT_ELICITATION_TTL_MS = 30 * 60 * 1000;
const WAIT_POLL_MS = 250;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;

export type TerminalElicitationResult = {
  status: "pending" | "answered" | "declined" | "expired";
  value?: string;
  note?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSubjectToken(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

export function deriveElicitationExpiresAt(jobTimeoutMs?: number, now = new Date()): string {
  const ttlMs = jobTimeoutMs ?? DEFAULT_ELICITATION_TTL_MS;
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function terminalFromEnvelope(envelope: unknown): TerminalElicitationResult | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const e = envelope as Record<string, unknown>;
  if (e.status === "answered") {
    const answer =
      e.answer && typeof e.answer === "object" ? (e.answer as Record<string, unknown>) : {};
    return {
      status: "answered",
      ...(typeof answer.value === "string" ? { value: answer.value } : {}),
      ...(typeof answer.note === "string" ? { note: answer.note } : {}),
    };
  }
  if (e.status === "declined") {
    const answer =
      e.answer && typeof e.answer === "object" ? (e.answer as Record<string, unknown>) : {};
    return {
      status: "declined",
      ...(typeof answer.note === "string" ? { note: answer.note } : {}),
    };
  }
  if (e.status === "expired") return { status: "expired" };
  return undefined;
}

async function readTerminalElicitation(id: string): Promise<TerminalElicitationResult | null> {
  const got = await ElicitationStorage.get({ id });
  if (!got.ok) throw new Error(got.error);
  if (!got.data) return { status: "pending" };
  return terminalFromEnvelope(got.data) ?? null;
}

export async function waitForTerminalElicitation(
  ctx: ToolContext,
  input: { id: string; workspaceId: string; sessionId: string; expiresAt: string },
): Promise<TerminalElicitationResult> {
  const deadlineMs = new Date(input.expiresAt).getTime();
  const nc = ctx.natsConnection;
  if (nc) {
    const subject = [
      "elicitations",
      sanitizeSubjectToken(input.workspaceId),
      sanitizeSubjectToken(input.sessionId),
      sanitizeSubjectToken(input.id),
    ].join(".");
    const sub = nc.subscribe(subject);
    const iter = (sub as AsyncIterable<{ data: Uint8Array }>)[Symbol.asyncIterator]();
    try {
      await nc.flush();
      // Close the read-before-subscribe race: an answer can land after the
      // caller created/read the pending row but before the broker registers
      // this subscriber. Once the subscription is flushed, re-read KV before
      // waiting for future stream events.
      const current = await readTerminalElicitation(input.id);
      if (current) return current;
      let nextMessage: Promise<IteratorResult<{ data: Uint8Array }>> | undefined;
      while (Date.now() < deadlineMs) {
        const remainingMs = Math.max(1, deadlineMs - Date.now());
        nextMessage ??= iter.next();
        const next = await Promise.race([
          nextMessage,
          sleep(Math.min(WAIT_POLL_MS, remainingMs)).then(() => null),
        ]);
        if (!next) {
          const polled = await readTerminalElicitation(input.id);
          if (polled) return polled;
          continue;
        }
        nextMessage = undefined;
        if (next.done) break;
        const text = new TextDecoder().decode(next.value.data);
        const terminal = terminalFromEnvelope(JSON.parse(text));
        if (terminal) return terminal;
      }
    } finally {
      try {
        sub.unsubscribe();
      } catch {
        // already closed
      }
    }
  }

  const initial = await readTerminalElicitation(input.id);
  if (initial) return initial;

  while (Date.now() < deadlineMs) {
    const current = await readTerminalElicitation(input.id);
    if (current) return current;
    await sleep(WAIT_POLL_MS);
  }
  await ElicitationStorage.expirePending({ now: new Date(input.expiresAt), limit: 500 });
  return { status: "expired" };
}
