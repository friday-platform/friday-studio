/** Hono factory with typed environment for all Ledger routes. */
import type { ActivityStorageAdapter } from "@atlas/activity";
import { createFactory } from "hono/factory";
import type { ResourceStorageAdapter } from "./types.ts";

type JwtPayload = { sub: string; user_metadata: { tempest_user_id: string } };

type Env = {
  Variables: {
    userId: string;
    jwtPayload: JwtPayload;
    /** Injected storage adapter for resource route handlers. */
    adapter: ResourceStorageAdapter;
    /** Injected storage adapter for activity route handlers. */
    activityAdapter: ActivityStorageAdapter;
  };
};

export const factory = createFactory<Env>();
export type { Env };
