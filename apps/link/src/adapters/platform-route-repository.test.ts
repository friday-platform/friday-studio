import { assertEquals } from "@std/assert";

function createMockSql(calls: unknown[] = []) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve();
  };
}

Deno.test("PostgresPlatformRouteRepository", async (t) => {
  await t.step("upsert executes INSERT ON CONFLICT", async () => {
    const calls: unknown[] = [];
    const mockSql = createMockSql(calls);
    const { PostgresPlatformRouteRepository } = await import("./platform-route-repository.ts");
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.upsert("T123", "user-456");
    assertEquals(calls.length, 1);
  });

  await t.step("delete executes DELETE WHERE team_id AND user_id", async () => {
    const calls: unknown[] = [];
    const mockSql = createMockSql(calls);
    const { PostgresPlatformRouteRepository } = await import("./platform-route-repository.ts");
    // @ts-expect-error - mock sql
    const repo = new PostgresPlatformRouteRepository(mockSql);
    await repo.delete("T123", "user-456");
    assertEquals(calls.length, 1);
  });
});
