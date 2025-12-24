/**
 * Hono factory with typed environment.
 * Single source of truth for context variables across all routes.
 */
import { createFactory } from "hono/factory";

type JwtPayload = {
  sub: string;
  user_metadata: { tempest_user_id: string; tempest_auth_user_id?: string };
};

type Env = {
  Variables: {
    userId: string;
    jwtPayload: JwtPayload;
    /** External base URL for generating URLs in responses/redirects. Includes proxy prefix if behind one. */
    externalBaseUrl: string;
  };
};

export const factory = createFactory<Env>();
export type { Env };
