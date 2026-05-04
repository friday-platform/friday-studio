/**
 * JetStream-backed user identity store.
 *
 * Single bucket `USERS` keyed by `userId`. Plus the special `_local` key
 * holding a pointer to the local single-tenant user's id (created on
 * first daemon start when no FRIDAY_KEY is configured).
 *
 * Identity is user-scoped — a User record travels across all workspaces
 * for that user. Compare with memory stores, which are workspace-scoped.
 *
 * The local-user pointer key (`_local`) is a special-cased string value
 * (just the userId, no JSON). The leading underscore keeps it out of the
 * way of nanoid keys, whose alphabet is alphanumeric only.
 */

import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { customAlphabet } from "nanoid";
import { type KV, type NatsConnection, StorageType } from "nats";
import { z } from "zod";

const KV_BUCKET = "USERS";
const LOCAL_USER_KEY = "_local";

/** Bumps when the onboarding script changes meaningfully. */
export const ONBOARDING_VERSION = 1;

const NANOID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NANOID_LENGTH = 12;
const generateId = customAlphabet(NANOID_ALPHABET, NANOID_LENGTH);

export const NameStatusSchema = z.enum(["unknown", "provided", "declined"]);
export type NameStatus = z.infer<typeof NameStatusSchema>;

export const UserIdentitySchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  nameStatus: NameStatusSchema,
  declinedAt: z.iso.datetime().optional(),
});
export type UserIdentity = z.infer<typeof UserIdentitySchema>;

export const OnboardingSchema = z.object({
  completedAt: z.iso.datetime().optional(),
  version: z.number().int().nonnegative(),
});
export type OnboardingState = z.infer<typeof OnboardingSchema>;

export const UserSchema = z.object({
  userId: z.string().min(1),
  identity: UserIdentitySchema,
  preferences: z.record(z.string(), z.unknown()),
  onboarding: OnboardingSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserSchema>;

const enc = new TextEncoder();
const dec = new TextDecoder();

function isCASConflict(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("wrong last sequence") || msg.includes("revision");
}

function emptyUser(userId: string, init?: Partial<UserIdentity>): User {
  const now = new Date().toISOString();
  return {
    userId,
    identity: {
      name: init?.name,
      email: init?.email,
      timezone: init?.timezone,
      locale: init?.locale,
      nameStatus: init?.nameStatus ?? "unknown",
      declinedAt: init?.declinedAt,
    },
    preferences: {},
    onboarding: { version: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

export interface JetStreamUserBackend {
  getUser(userId: string): Promise<Result<User | null, string>>;
  ensureUser(userId: string, init?: Partial<UserIdentity>): Promise<Result<User, string>>;
  setUserIdentity(userId: string, patch: Partial<UserIdentity>): Promise<Result<User, string>>;
  markOnboardingComplete(userId: string, version: number): Promise<Result<User, string>>;
  resolveLocalUserId(): Promise<Result<string, string>>;
}

export async function ensureUsersKVBucket(nc: NatsConnection): Promise<KV> {
  const js = nc.jetstream();
  return await js.views.kv(KV_BUCKET, { history: 5, storage: StorageType.File });
}

export function createJetStreamUserBackend(nc: NatsConnection): JetStreamUserBackend {
  let cachedKV: KV | null = null;

  async function kv(): Promise<KV> {
    if (cachedKV) return cachedKV;
    cachedKV = await ensureUsersKVBucket(nc);
    return cachedKV;
  }

  async function readUser(userId: string): Promise<User | null> {
    const k = await kv();
    const entry = await k.get(userId);
    if (!entry || entry.operation !== "PUT") return null;
    return UserSchema.parse(JSON.parse(dec.decode(entry.value)));
  }

  /**
   * Read-modify-write with CAS retry. Creates an empty User record on
   * the missing-key path so every mutation is also a create-if-needed.
   * `identityInit` seeds the identity fields when the record is being
   * created for the first time; ignored on update.
   */
  async function updateUser(
    userId: string,
    mut: (current: User) => User,
    identityInit?: Partial<UserIdentity>,
  ): Promise<User> {
    const k = await kv();
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await k.get(userId);
      let current: User;
      let revision: bigint | undefined;
      if (!entry || entry.operation !== "PUT") {
        current = emptyUser(userId, identityInit);
        revision = undefined; // create
      } else {
        current = UserSchema.parse(JSON.parse(dec.decode(entry.value)));
        revision = entry.revision;
      }
      const next: User = { ...mut(current), updatedAt: new Date().toISOString() };
      try {
        if (revision === undefined) {
          await k.create(userId, enc.encode(JSON.stringify(next)));
        } else {
          await k.update(userId, enc.encode(JSON.stringify(next)), revision);
        }
        return next;
      } catch (err) {
        if (isCASConflict(err) && attempt < 7) continue;
        throw err;
      }
    }
    throw new Error(`User update failed after 8 CAS retries: ${userId}`);
  }

  async function getUser(userId: string): Promise<Result<User | null, string>> {
    try {
      return success(await readUser(userId));
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function ensureUser(
    userId: string,
    init?: Partial<UserIdentity>,
  ): Promise<Result<User, string>> {
    try {
      const existing = await readUser(userId);
      if (existing) return success(existing);
      const created = await updateUser(userId, (u) => u, init);
      return success(created);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function setUserIdentity(
    userId: string,
    patch: Partial<UserIdentity>,
  ): Promise<Result<User, string>> {
    try {
      const next = await updateUser(
        userId,
        (u) => ({ ...u, identity: { ...u.identity, ...patch } }),
        patch,
      );
      return success(next);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function markOnboardingComplete(
    userId: string,
    version: number,
  ): Promise<Result<User, string>> {
    try {
      const next = await updateUser(userId, (u) => ({
        ...u,
        onboarding: { completedAt: new Date().toISOString(), version },
      }));
      return success(next);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  /**
   * Resolve the local single-tenant user's id. On first call (no `_local`
   * pointer in KV), generates a nanoid, creates an empty User record, and
   * stores the pointer. Subsequent calls return the same id.
   */
  async function resolveLocalUserId(): Promise<Result<string, string>> {
    try {
      const k = await kv();
      const existing = await k.get(LOCAL_USER_KEY);
      if (existing && existing.operation === "PUT") {
        return success(dec.decode(existing.value));
      }
      const userId = generateId();
      // Create the User record first so the pointer never points at a
      // missing record.
      await updateUser(userId, (u) => u, { nameStatus: "unknown" });
      try {
        await k.create(LOCAL_USER_KEY, enc.encode(userId));
      } catch (err) {
        if (isCASConflict(err)) {
          // Another caller raced us. Read and return their id.
          const winner = await k.get(LOCAL_USER_KEY);
          if (winner && winner.operation === "PUT") {
            return success(dec.decode(winner.value));
          }
        }
        throw err;
      }
      return success(userId);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  return { getUser, ensureUser, setUserIdentity, markOnboardingComplete, resolveLocalUserId };
}
