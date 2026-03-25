import { logger } from "@atlas/logger";
import type { Sql } from "postgres";

/** Service-level table — no RLS user context needed. */
export interface WebhookSecretRepository {
  insert(appId: string, userId: string, signingSecret: string): Promise<void>;
  delete(appId: string): Promise<void>;
}

/** No-op implementation for dev mode. */
export class NoOpWebhookSecretRepository implements WebhookSecretRepository {
  insert(appId: string, userId: string): Promise<void> {
    logger.info("webhook_secret_insert_noop", { appId, userId });
    return Promise.resolve();
  }

  delete(appId: string): Promise<void> {
    logger.info("webhook_secret_delete_noop", { appId });
    return Promise.resolve();
  }
}

/** PostgreSQL-backed implementation. */
export class PostgresWebhookSecretRepository implements WebhookSecretRepository {
  constructor(private readonly sql: Sql) {}

  async insert(appId: string, userId: string, signingSecret: string): Promise<void> {
    await this.sql`
      INSERT INTO slack_app_webhook (app_id, user_id, signing_secret)
      VALUES (${appId}, ${userId}, ${signingSecret})
      ON CONFLICT (app_id) DO UPDATE SET signing_secret = EXCLUDED.signing_secret, user_id = EXCLUDED.user_id
    `;
  }

  async delete(appId: string): Promise<void> {
    await this.sql`
      DELETE FROM slack_app_webhook WHERE app_id = ${appId}
    `;
  }
}
