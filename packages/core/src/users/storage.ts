/**
 * User identity storage facade.
 *
 * Mirrors the `ChatStorage` shape: a singleton backend initialized once
 * at daemon startup via `initUserStorage(nc)`, exposed as the
 * `UserStorage.*` namespace for callers.
 *
 * Identity is per-user, cross-workspace. See jetstream-backend.ts for
 * the data model.
 */

import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import {
  createJetStreamUserBackend,
  type JetStreamUserBackend,
  type User,
  type UserIdentity,
} from "./jetstream-backend.ts";

export type { NameStatus, OnboardingState, User, UserIdentity } from "./jetstream-backend.ts";
export {
  ensureUsersKVBucket,
  ONBOARDING_VERSION,
  OnboardingSchema,
  UserIdentitySchema,
  UserSchema,
} from "./jetstream-backend.ts";

let backend: JetStreamUserBackend | null = null;

export function initUserStorage(nc: NatsConnection): void {
  backend = createJetStreamUserBackend(nc);
}

function b(): JetStreamUserBackend {
  if (!backend) {
    throw new Error("UserStorage not initialized — call initUserStorage(nc) at daemon startup");
  }
  return backend;
}

function getUser(userId: string): Promise<Result<User | null, string>> {
  return b().getUser(userId);
}

function ensureUser(userId: string, init?: Partial<UserIdentity>): Promise<Result<User, string>> {
  return b().ensureUser(userId, init);
}

function setUserIdentity(
  userId: string,
  patch: Partial<UserIdentity>,
): Promise<Result<User, string>> {
  return b().setUserIdentity(userId, patch);
}

function markOnboardingComplete(userId: string, version: number): Promise<Result<User, string>> {
  return b().markOnboardingComplete(userId, version);
}

function resolveLocalUserId(): Promise<Result<string, string>> {
  return b().resolveLocalUserId();
}

export const UserStorage = {
  getUser,
  ensureUser,
  setUserIdentity,
  markOnboardingComplete,
  resolveLocalUserId,
};
