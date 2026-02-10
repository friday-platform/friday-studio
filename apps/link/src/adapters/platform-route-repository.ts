import { logger } from "@atlas/logger";
import type { Sql } from "postgres";
import { withUserContext } from "./rls.ts";

export class RouteOwnershipError extends Error {
  constructor(teamId: string) {
    super(`Route ${teamId} is owned by another user`);
    this.name = "RouteOwnershipError";
  }
}

/**
 * Repository interface for platform route storage.
 * Routes team_id → user_id for signal-gateway event routing.
 *
 * Write methods use `withUserContext()` for RLS enforcement.
 * Ownership checks use `is_route_claimable()` SECURITY DEFINER function
 * (works from any role, no BYPASSRLS required).
 */
export interface PlatformRouteRepository {
  /**
   * Upsert a platform route.
   * RLS restricts writes to own rows — cross-user overwrites are impossible.
   */
  upsert(teamId: string, userId: string, platform: string): Promise<void>;

  /**
   * Delete a platform route by team_id and user_id.
   * RLS restricts deletion to own rows.
   */
  delete(teamId: string, userId: string): Promise<void>;

  /**
   * Check if a route is claimable by the given user.
   * Returns true if the route doesn't exist or is already owned by this user.
   * Returns false if another user owns the route.
   */
  isClaimable(teamId: string, userId: string): Promise<boolean>;

  /**
   * List all team_ids owned by a user, optionally filtered by platform.
   */
  listByUser(userId: string, platform?: string): Promise<string[]>;
}

/**
 * No-op platform route repository for dev mode without Postgres.
 * Logs the route but doesn't persist it - useful for testing OAuth flows.
 */
export class NoOpPlatformRouteRepository implements PlatformRouteRepository {
  upsert(teamId: string, userId: string, platform: string): Promise<void> {
    logger.info("platform_route_upsert_noop", { teamId, userId, platform });
    return Promise.resolve();
  }

  delete(teamId: string, userId: string): Promise<void> {
    logger.info("platform_route_delete_noop", { teamId, userId });
    return Promise.resolve();
  }

  isClaimable(_teamId: string, _userId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  listByUser(_userId: string, _platform?: string): Promise<string[]> {
    return Promise.resolve([]);
  }
}

/**
 * PostgreSQL-backed platform route repository.
 *
 * Write operations and listByUser use `withUserContext()` for RLS enforcement.
 * Ownership checks use `is_route_claimable()` SECURITY DEFINER function —
 * no connection-level BYPASSRLS required.
 *
 * RLS policies (RESTRICTIVE baseline + PERMISSIVE per-operation):
 * - All operations restricted to own user_id for authenticated role
 * - Signal-gateway uses service role for webhook routing (read-only, no user context)
 */
export class PostgresPlatformRouteRepository implements PlatformRouteRepository {
  constructor(private readonly sql: Sql) {}

  async upsert(teamId: string, userId: string, platform: string): Promise<void> {
    // INSERT + ownership check in one transaction (no TOCTOU gap).
    // ON CONFLICT DO NOTHING: if another user owns this route, the INSERT
    // silently skips. is_route_claimable() (SECURITY DEFINER) then checks
    // ownership across all users, even within the authenticated RLS context.
    await withUserContext(this.sql, userId, async (tx) => {
      const result = await tx`
        INSERT INTO platform_route (team_id, user_id, platform)
        VALUES (${teamId}, ${userId}, ${platform})
        ON CONFLICT (team_id) DO NOTHING
      `;
      if (result.count === 0) {
        const [row] = await tx`SELECT public.is_route_claimable(${teamId}, ${userId}) as claimable`;
        if (!row?.claimable) {
          throw new RouteOwnershipError(teamId);
        }
        // Same-user re-upsert: update platform in case it changed (e.g., backfill correction)
        await tx`UPDATE platform_route SET platform = ${platform} WHERE team_id = ${teamId}`;
      }
    });
  }

  async delete(teamId: string, userId: string): Promise<void> {
    await withUserContext(
      this.sql,
      userId,
      (tx) => tx`DELETE FROM platform_route WHERE team_id = ${teamId} AND user_id = ${userId}`,
    );
  }

  async isClaimable(teamId: string, userId: string): Promise<boolean> {
    const [row] = await this
      .sql`SELECT public.is_route_claimable(${teamId}, ${userId}) as claimable`;
    return row?.claimable ?? false;
  }

  listByUser(userId: string, platform?: string): Promise<string[]> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = platform
        ? await tx`SELECT team_id FROM platform_route WHERE user_id = ${userId} AND platform = ${platform}`
        : await tx`SELECT team_id FROM platform_route WHERE user_id = ${userId}`;
      return rows.map((r) => r.team_id);
    });
  }
}
