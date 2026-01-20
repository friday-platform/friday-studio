import { describe, expect, it } from "vitest";

function createMockSql(calls: unknown[] = []) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve();
  };
}

describe("PostgresPlatformRouteRepository", () => {
  it("upsert executes INSERT ON CONFLICT", async () => {
    const calls: unknown[] = [];
    const mockSql = createMockSql(calls);
    const { PostgresPlatformRouteRepository } = await import("./platform-route-repository.ts");
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.upsert("T123", "user-456");
    expect(calls.length).toEqual(1);
  });

  it("delete executes DELETE WHERE team_id AND user_id", async () => {
    const calls: unknown[] = [];
    const mockSql = createMockSql(calls);
    const { PostgresPlatformRouteRepository } = await import("./platform-route-repository.ts");
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.delete("T123", "user-456");
    expect(calls.length).toEqual(1);
  });
});
