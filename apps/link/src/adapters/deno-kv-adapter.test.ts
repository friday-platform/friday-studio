import { assertEquals, assertExists } from "@std/assert";
import { DenoKVStorageAdapter } from "./deno-kv-adapter.ts";

Deno.test("DenoKVStorageAdapter tenant isolation", async (t) => {
  const tempFile = await Deno.makeTempFile();
  const adapter = new DenoKVStorageAdapter(tempFile);

  const credInput = {
    type: "oauth" as const,
    provider: "test",
    label: "Test",
    secret: { access_token: "secret" },
  };

  let credIdA: string;

  await t.step("user A save returns SaveResult, user A get = found", async () => {
    const result = await adapter.save(credInput, "user-a");
    assertExists(result.id);
    assertExists(result.metadata.createdAt);
    assertExists(result.metadata.updatedAt);
    credIdA = result.id;
    const retrieved = await adapter.get(credIdA, "user-a");
    assertExists(retrieved);
    assertEquals(retrieved.type, credInput.type);
    assertEquals(retrieved.provider, credInput.provider);
    assertEquals(retrieved.label, credInput.label);
    assertEquals(retrieved.secret, credInput.secret);
  });

  await t.step("user A save, user B get = not found", async () => {
    assertEquals(await adapter.get(credIdA, "user-b"), null);
  });

  await t.step("list only returns current user credentials", async () => {
    await adapter.save(credInput, "user-b");
    const list = await adapter.list("oauth", "user-a");
    assertEquals(list.length, 1);
    assertEquals(list[0]?.id, credIdA);
  });

  await Deno.remove(tempFile);
});
