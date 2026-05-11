/**
 * Session storage facade. Mirrors `ChatStorage` and `UserStorage`:
 * one backend initialized at daemon startup, exposed as
 * `SessionStorage.*` to call sites.
 */

import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import {
  createJetStreamSessionBackend,
  type JetStreamSessionBackend,
  type SessionRecord,
} from "./jetstream-backend.ts";

export type { SessionRecord } from "./jetstream-backend.ts";
export {
  DEFAULT_SESSION_TTL_MS,
  ensureSessionsKVBucket,
  mintSessionToken,
  SessionRecordSchema,
} from "./jetstream-backend.ts";

let backend: JetStreamSessionBackend | null = null;

export function initSessionStorage(nc: NatsConnection): void {
  backend = createJetStreamSessionBackend(nc);
}

function b(): JetStreamSessionBackend {
  if (!backend) {
    throw new Error(
      "SessionStorage not initialized — call initSessionStorage(nc) at daemon startup",
    );
  }
  return backend;
}

function createSession(
  userId: string,
  ttlMs?: number,
): Promise<Result<{ token: string; record: SessionRecord }, string>> {
  return b().createSession(userId, ttlMs);
}

function getSession(token: string): Promise<Result<SessionRecord | null, string>> {
  return b().getSession(token);
}

function deleteSession(token: string): Promise<Result<void, string>> {
  return b().deleteSession(token);
}

export const SessionStorage = { createSession, getSession, deleteSession };
