import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DenoKVStorageAdapter } from "./deno-kv-adapter.ts";

describe("DenoKVStorageAdapter tenant isolation", () => {
  const tempFile = join(tmpdir(), `deno-kv-test-${randomUUID()}.db`);
  const adapter = new DenoKVStorageAdapter(tempFile);

  afterAll(async () => {
    await rm(tempFile, { force: true });
  });

  const credInput = {
    type: "oauth" as const,
    provider: "test",
    label: "Test",
    secret: { access_token: "secret" },
  };

  let credIdA: string;

  it("user A save returns SaveResult, user A get = found", async () => {
    const result = await adapter.save(credInput, "user-a");
    expect(result.id).toBeDefined();
    expect(result.metadata.createdAt).toBeDefined();
    expect(result.metadata.updatedAt).toBeDefined();
    credIdA = result.id;
    const retrieved = await adapter.get(credIdA, "user-a");
    expect(retrieved).toBeDefined();
    expect(retrieved!.type).toEqual(credInput.type);
    expect(retrieved!.provider).toEqual(credInput.provider);
    expect(retrieved!.label).toEqual(credInput.label);
    expect(retrieved!.secret).toEqual(credInput.secret);
  });

  it("user A save, user B get = not found", async () => {
    expect(await adapter.get(credIdA, "user-b")).toBeNull();
  });

  it("list only returns current user credentials", async () => {
    await adapter.save(credInput, "user-b");
    const list = await adapter.list("oauth", "user-a");
    expect(list.length).toEqual(1);
    expect(list[0]?.id).toEqual(credIdA);
  });
});
