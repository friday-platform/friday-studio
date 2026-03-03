/** Hono factory with typed environment for all Ledger routes. */
import { createFactory } from "hono/factory";
import type { ResourceStorageAdapter } from "./types.ts";

type JwtPayload = { sub: string; user_metadata: { tempest_user_id: string } };

type Env = {
  Variables: {
    userId: string;
    jwtPayload: JwtPayload;
    /** Injected storage adapter for route handlers. */
    adapter: ResourceStorageAdapter;
  };
};

export const factory = createFactory<Env>();
export type { Env };
