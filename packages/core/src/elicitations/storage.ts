import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import { JetStreamElicitationStorageAdapter } from "./jetstream-adapter.ts";
import type {
  CreateElicitationInput,
  Elicitation,
  ElicitationAnswer,
  ElicitationStatus,
} from "./model.ts";
import {
  initToolAccessGrantStorage,
  resetToolAccessGrantStorageForTests,
} from "./tool-access-grants.ts";
import type { ElicitationStorageAdapter, ExpireSweepResult } from "./types.ts";

let adapter: ElicitationStorageAdapter | null = null;

/**
 * Wire elicitation storage to a NATS connection. Daemon calls this
 * once at startup (alongside `initArtifactStorage` etc.). Subsequent
 * `ElicitationStorage.*` calls go through the JetStream adapter.
 */
export function initElicitationStorage(nc: NatsConnection): void {
  adapter = new JetStreamElicitationStorageAdapter(nc);
  initToolAccessGrantStorage(nc);
}

/**
 * Test/migration hook — drop the cached adapter so a subsequent
 * `initElicitationStorage` rebinds. Not part of the runtime path.
 */
export function resetElicitationStorageForTests(): void {
  adapter = null;
  resetToolAccessGrantStorageForTests();
}

function require_(): ElicitationStorageAdapter {
  if (!adapter) {
    throw new Error(
      "Elicitation storage not initialized — call initElicitationStorage(nc) at daemon startup",
    );
  }
  return adapter;
}

/**
 * Elicitation storage facade. Mirrors the artifact-storage pattern:
 * lazy-init via `initElicitationStorage(nc)`; module-level facade
 * delegates to the JetStream adapter once wired.
 */
export const ElicitationStorage: ElicitationStorageAdapter = {
  create: (input: CreateElicitationInput): Promise<Result<Elicitation, string>> =>
    require_().create(input),
  get: (input: { id: string }): Promise<Result<Elicitation | null, string>> =>
    require_().get(input),
  list: (input: {
    workspaceId?: string;
    sessionId?: string;
    status?: ElicitationStatus;
  }): Promise<Result<Elicitation[], string>> => require_().list(input),
  answer: (input: {
    id: string;
    answer: ElicitationAnswer;
  }): Promise<Result<Elicitation, string>> => require_().answer(input),
  decline: (input: { id: string; note?: string }): Promise<Result<Elicitation, string>> =>
    require_().decline(input),
  expirePending: (
    input: { now?: Date; limit?: number } = {},
  ): Promise<Result<ExpireSweepResult, string>> => require_().expirePending(input),
};
