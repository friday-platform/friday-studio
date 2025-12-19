/**
 * Hono factory with typed environment.
 * Single source of truth for context variables across all routes.
 */
import { createFactory } from "hono/factory";

type JwtPayload = {
  sub: string;
  user_metadata: { tempest_user_id: string; tempest_auth_user_id?: string };
};

type Env = { Variables: { userId: string; jwtPayload: JwtPayload } };

export const factory = createFactory<Env>();
export type { Env };
