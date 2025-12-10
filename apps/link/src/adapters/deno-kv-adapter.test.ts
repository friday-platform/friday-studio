import { assertEquals } from "@std/assert";
import { DenoKVStorageAdapter } from "./deno-kv-adapter.ts";

Deno.test("DenoKVStorageAdapter tenant isolation", async (t) => {
  const tempFile = await Deno.makeTempFile();
  const adapter = new DenoKVStorageAdapter(tempFile);

  const cred = {
    id: "test-cred",
    type: "oauth" as const,
    provider: "test",
    label: "Test",
    secret: { access_token: "secret" },
    metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-01" },
  };

  await t.step("user A save, user A get = found", async () => {
    await adapter.save(cred, "user-a");
    assertEquals(await adapter.get("test-cred", "user-a"), cred);
  });

  await t.step("user A save, user B get = not found", async () => {
    assertEquals(await adapter.get("test-cred", "user-b"), null);
  });

  await t.step("list only returns current user credentials", async () => {
    await adapter.save({ ...cred, id: "cred-b" }, "user-b");
    const list = await adapter.list("oauth", "user-a");
    assertEquals(list.length, 1);
    assertEquals(list[0]?.id, "test-cred");
  });

  await Deno.remove(tempFile);
});
