import { logger } from "@atlas/logger";
import type { Sql } from "postgres";

/**
 * Repository interface for platform route storage.
 * Routes team_id → user_id for signal-gateway event routing.
 */
export interface PlatformRouteRepository {
  /**
   * Upsert a platform route.
   * If team_id exists, update user_id. Idempotent.
   */
  upsert(teamId: string, userId: string): Promise<void>;
}

/**
 * No-op platform route repository for dev mode without Postgres.
 * Logs the route but doesn't persist it - useful for testing OAuth flows.
 */
export class NoOpPlatformRouteRepository implements PlatformRouteRepository {
  upsert(teamId: string, userId: string): Promise<void> {
    logger.info("platform_route_upsert_noop", { teamId, userId });
    return Promise.resolve();
  }
}

/**
 * PostgreSQL-backed platform route repository.
 *
 * This repository:
 * - Maps external platform IDs (e.g., Slack team_id) to user IDs
 * - Enables signal-gateway to route incoming platform events to workspaces
 * - Uses the existing platform_route table
 */
export class PostgresPlatformRouteRepository implements PlatformRouteRepository {
  constructor(private readonly sql: Sql) {}

  async upsert(teamId: string, userId: string): Promise<void> {
    await this.sql`
      INSERT INTO platform_route (team_id, user_id)
      VALUES (${teamId}, ${userId})
      ON CONFLICT (team_id)
      DO UPDATE SET user_id = EXCLUDED.user_id
    `;
  }
}
