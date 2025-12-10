/**
 * Hono factory with typed environment.
 * Single source of truth for context variables across all routes.
 */
import { createFactory } from "hono/factory";

type Env = { Variables: { userId: string } };

export const factory = createFactory<Env>();
export type { Env };
