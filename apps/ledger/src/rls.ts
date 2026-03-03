import type { Sql } from "postgres";

/**
 * Executes a function within a transaction with the request.user_id session
 * variable set for RLS (Row-Level Security) policy enforcement.
 *
 * Required for RLS policies that filter by:
 *   user_id = current_setting('request.user_id', true)
 *
 * SECURITY: set_config runs BEFORE SET LOCAL ROLE so it executes as the
 * connection owner (superuser). EXECUTE on set_config is revoked from
 * authenticated (see migration), so code running as authenticated physically
 * cannot change request.user_id — the database enforces this, not app code.
 *
 * Both settings use LOCAL scope (transaction-only) to prevent leakage across
 * pooled connections.
 *
 * @param sql - The postgres SQL client
 * @param userId - The user ID to set in the session variable
 * @param fn - The function to execute within the transaction
 * @returns The result of the function
 */
export function withUserContext<T>(
  sql: Sql,
  userId: string,
  fn: (tx: Sql) => T | Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // Order matters: set_config first (as connection owner), then drop to
    // authenticated. After role change, set_config is no longer callable.
    await tx`SELECT set_config('request.user_id', ${userId}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    // Default timeout for all operations — agent SQL overrides with a shorter
    // timeout (10s). Prevents runaway queries from exhausting connections.
    await tx`SET LOCAL statement_timeout = '30s'`;
    return fn(tx);
  }) as Promise<T>;
}
