import { describe, expect, it } from "vitest";
import {
  PostgresPlatformRouteRepository,
  RouteOwnershipError,
} from "./platform-route-repository.ts";

type SqlCall = { sql: string; values: unknown[] };

/**
 * Joins a tagged template's string fragments with $N placeholders,
 * producing the SQL statement as postgres.js would execute it.
 */
function toSql(strings: string[], values: unknown[]): string {
  return strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ""), "");
}

/**
 * Creates a mock SQL client that records every query as `{ sql, values }`.
 * Queries are matched by content — the `responses` map lets specific SQL
 * patterns return specific results instead of relying on call order.
 */
function createMockSql(responses: Record<string, unknown> = {}) {
  const calls: SqlCall[] = [];

  function matchResponse(sql: string): unknown {
    for (const [pattern, result] of Object.entries(responses)) {
      if (sql.includes(pattern)) return result;
    }
    return Object.assign([], { count: 1 });
  }

  const tagFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = toSql([...strings], values);
    calls.push({ sql, values });
    return Promise.resolve(matchResponse(sql));
  };

  tagFn.begin = (fn: (tx: typeof tagFn) => Promise<unknown>) => fn(tagFn);
  tagFn.calls = calls;

  return tagFn;
}

/** Helper: find calls whose SQL contains the given substring. */
function queriesContaining(calls: SqlCall[], pattern: string): SqlCall[] {
  return calls.filter((c) => c.sql.includes(pattern));
}

describe("PostgresPlatformRouteRepository", () => {
  it("upsert sends INSERT ON CONFLICT within RLS context", async () => {
    const mockSql = createMockSql();
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.upsert("T123", "user-456", "slack");

    expect(queriesContaining(mockSql.calls, "SET LOCAL ROLE")).toHaveLength(1);
    expect(queriesContaining(mockSql.calls, "request.user_id")).toHaveLength(1);
    const inserts = queriesContaining(mockSql.calls, "INSERT INTO platform_route");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.sql).toContain("ON CONFLICT");
    expect(inserts[0]?.values).toEqual(["T123", "user-456", "slack"]);
  });

  it("upsert checks claimability and updates platform on same-user re-upsert", async () => {
    const mockSql = createMockSql({
      "INSERT INTO platform_route": Object.assign([], { count: 0 }),
      is_route_claimable: [{ claimable: true }],
    });
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.upsert("T123", "user-456", "github");

    expect(queriesContaining(mockSql.calls, "is_route_claimable")).toHaveLength(1);
    const updates = queriesContaining(mockSql.calls, "UPDATE platform_route");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("platform");
  });

  it("upsert throws when INSERT conflicts and route is not claimable", async () => {
    const mockSql = createMockSql({
      "INSERT INTO platform_route": Object.assign([], { count: 0 }),
      is_route_claimable: [{ claimable: false }],
    });
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);

    await expect(repo.upsert("T123", "user-456", "slack")).rejects.toBeInstanceOf(
      RouteOwnershipError,
    );
    // No UPDATE should have been attempted
    expect(queriesContaining(mockSql.calls, "UPDATE")).toHaveLength(0);
  });

  it("delete sends DELETE within RLS context", async () => {
    const mockSql = createMockSql();
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.delete("T123", "user-456");

    expect(queriesContaining(mockSql.calls, "SET LOCAL ROLE")).toHaveLength(1);
    const deletes = queriesContaining(mockSql.calls, "DELETE FROM platform_route");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.values).toEqual(["T123", "user-456"]);
  });

  it("isClaimable calls SECURITY DEFINER function without RLS context", async () => {
    const mockSql = createMockSql({ is_route_claimable: [{ claimable: true }] });
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    const result = await repo.isClaimable("T123", "user-456");

    expect(result).toBe(true);
    // No RLS setup — isClaimable runs outside withUserContext
    expect(queriesContaining(mockSql.calls, "SET LOCAL ROLE")).toHaveLength(0);
    expect(queriesContaining(mockSql.calls, "is_route_claimable")).toHaveLength(1);
  });

  it("isClaimable defaults to false on missing row", async () => {
    const mockSql = createMockSql({ is_route_claimable: [] });
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    const result = await repo.isClaimable("T123", "user-456");

    expect(result).toBe(false);
  });

  it("listByUser queries within RLS context", async () => {
    const mockSql = createMockSql({ "SELECT team_id": [{ team_id: "T-1" }, { team_id: "T-2" }] });
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    const result = await repo.listByUser("user-456");

    expect(queriesContaining(mockSql.calls, "SET LOCAL ROLE")).toHaveLength(1);
    expect(queriesContaining(mockSql.calls, "SELECT team_id")).toHaveLength(1);
    expect(result).toEqual(["T-1", "T-2"]);
  });

  it("listByUser filters by platform when provided", async () => {
    const mockSql = createMockSql({ "SELECT team_id": [{ team_id: "T-github" }] });
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    const result = await repo.listByUser("user-456", "github");

    const selects = queriesContaining(mockSql.calls, "SELECT team_id");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.sql).toContain("platform");
    expect(result).toEqual(["T-github"]);
  });
});
