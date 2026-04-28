import type { Sql, TransactionSql } from "postgres";

/**
 * Executes a function within a transaction with the request.user_id session
 * variable set for RLS (Row-Level Security) policy enforcement.
 *
 * This is required for RLS policies that filter by:
 *   user_id = current_setting('request.user_id', true)
 *
 * The session variable is set with LOCAL scope (transaction-only) to ensure
 * it doesn't leak to other queries using the same connection from the pool.
 *
 * @param sql - The postgres SQL client
 * @param userId - The user ID to set in the session variable
 * @param fn - The function to execute within the transaction
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * const rows = await withUserContext(sql, userId, async (tx) => {
 *   return await tx<CredentialRow[]>`
 *     SELECT * FROM public.credential
 *     WHERE id = ${id} AND deleted_at IS NULL
 *   `;
 * });
 * ```
 */
export function withUserContext<T>(
  sql: Sql,
  userId: string,
  fn: (tx: TransactionSql) => T | Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // Order matters: set_config first (as connection owner), then drop to
    // authenticated. After role change, set_config is no longer callable
    // (EXECUTE revoked from PUBLIC in ledger migration).
    await tx`SELECT set_config('request.user_id', ${userId}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    return fn(tx);
  }) as Promise<T>;
}
