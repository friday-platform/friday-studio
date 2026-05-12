/**
 * Workspace membership storage facade.
 *
 * Mirrors UserStorage / ChatStorage: a singleton backend initialized
 * once at daemon startup via `initWorkspaceMemberStorage(nc)`, exposed
 * as the `WorkspaceMemberStorage.*` namespace.
 */

import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import {
  createJetStreamWorkspaceMemberBackend,
  type JetStreamWorkspaceMemberBackend,
  type WorkspaceMembership,
} from "./jetstream-backend.ts";

export type { Role, WorkspaceMembership } from "./jetstream-backend.ts";
export {
  ensureWorkspaceMembersKVBucket,
  RoleSchema,
  WorkspaceMembershipSchema,
} from "./jetstream-backend.ts";

let backend: JetStreamWorkspaceMemberBackend | null = null;

export function initWorkspaceMemberStorage(nc: NatsConnection): void {
  backend = createJetStreamWorkspaceMemberBackend(nc);
}

export function resetWorkspaceMemberStorageForTests(): void {
  backend = null;
}

function b(): JetStreamWorkspaceMemberBackend {
  if (!backend) {
    throw new Error(
      "WorkspaceMemberStorage not initialized — call initWorkspaceMemberStorage(nc) at daemon startup",
    );
  }
  return backend;
}

function get(userId: string, wsId: string): Promise<Result<WorkspaceMembership | null, string>> {
  return b().get(userId, wsId);
}

function listByUser(userId: string): Promise<Result<WorkspaceMembership[], string>> {
  return b().listByUser(userId);
}

function listByWorkspace(wsId: string): Promise<Result<WorkspaceMembership[], string>> {
  return b().listByWorkspace(wsId);
}

function put(m: WorkspaceMembership): Promise<Result<WorkspaceMembership, string>> {
  return b().put(m);
}

function putIfAbsent(
  m: WorkspaceMembership,
): Promise<Result<WorkspaceMembership | "exists", string>> {
  return b().putIfAbsent(m);
}

function del(userId: string, wsId: string): Promise<Result<void, string>> {
  return b().delete(userId, wsId);
}

export const WorkspaceMemberStorage = {
  get,
  listByUser,
  listByWorkspace,
  put,
  putIfAbsent,
  delete: del,
};
