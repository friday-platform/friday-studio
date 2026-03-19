import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileSystemStorageAdapter } from "./filesystem-adapter.ts";

describe("FileSystemStorageAdapter tenant isolation", () => {
  const tempDir = join(tmpdir(), `fs-adapter-test-${randomUUID()}`);
  const adapter = new FileSystemStorageAdapter(tempDir);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const credInput = {
    type: "oauth" as const,
    provider: "test",
    label: "Test",
    secret: { access_token: "secret" },
  };

  let credIdA: string;
  let metadataA: { createdAt: string; updatedAt: string };

  it("user A save returns SaveResult, user A get = found", async () => {
    const result = await adapter.save(credInput, "user-a");
    expect(result).toMatchObject({
      id: expect.any(String),
      metadata: { createdAt: expect.any(String), updatedAt: expect.any(String) },
    });
    credIdA = result.id;
    metadataA = result.metadata;

    const retrieved = await adapter.get(credIdA, "user-a");
    expect(retrieved).toMatchObject({
      type: credInput.type,
      provider: credInput.provider,
      label: credInput.label,
      secret: credInput.secret,
    });
  });

  it("user A save, user B get = not found", async () => {
    expect(await adapter.get(credIdA, "user-b")).toBeNull();
  });

  it("update modifies credential, updates updatedAt, preserves createdAt", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updatedMetadata = await adapter.update(
      credIdA,
      {
        type: "oauth",
        provider: "test",
        label: "Updated Label",
        secret: { access_token: "new-secret" },
      },
      "user-a",
    );

    expect(updatedMetadata.createdAt).toBe(metadataA.createdAt);
    expect(updatedMetadata.updatedAt).not.toBe(metadataA.updatedAt);
    expect(new Date(updatedMetadata.updatedAt).getTime()).toBeGreaterThan(
      new Date(metadataA.updatedAt).getTime(),
    );

    expect(await adapter.get(credIdA, "user-a")).toMatchObject({
      label: "Updated Label",
      secret: { access_token: "new-secret" },
      metadata: { createdAt: metadataA.createdAt },
    });
  });

  it("update throws if credential not found", async () => {
    await expect(adapter.update("nonexistent-id", credInput, "user-a")).rejects.toThrow(
      "Credential not found",
    );
  });

  it("update throws if wrong userId (tenant isolation)", async () => {
    await expect(adapter.update(credIdA, credInput, "user-b")).rejects.toThrow(
      "Credential not found",
    );
  });

  it("upsert creates new credential when no match exists", async () => {
    const result = await adapter.upsert(
      {
        type: "oauth",
        provider: "github",
        label: "GitHub Account",
        secret: { access_token: "gh-token" },
      },
      "user-a",
    );

    expect(result).toMatchObject({
      id: expect.any(String),
      metadata: { createdAt: expect.any(String), updatedAt: expect.any(String) },
    });
    expect(result.metadata.createdAt).toBe(result.metadata.updatedAt);

    expect(await adapter.get(result.id, "user-a")).toMatchObject({
      provider: "github",
      label: "GitHub Account",
    });
  });

  it("upsert updates existing when provider+label matches", async () => {
    const createResult = await adapter.upsert(
      {
        type: "oauth",
        provider: "slack",
        label: "Slack Workspace",
        secret: { access_token: "slack-token-v1" },
      },
      "user-a",
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updateResult = await adapter.upsert(
      {
        type: "oauth",
        provider: "slack",
        label: "Slack Workspace",
        secret: { access_token: "slack-token-v2" },
      },
      "user-a",
    );

    expect(updateResult.id).toBe(createResult.id);
    expect(updateResult.metadata.createdAt).toBe(createResult.metadata.createdAt);
    expect(updateResult.metadata.updatedAt).not.toBe(createResult.metadata.createdAt);

    expect(await adapter.get(updateResult.id, "user-a")).toMatchObject({
      secret: { access_token: "slack-token-v2" },
    });
  });

  it("upsert respects tenant isolation (different users can have same provider+label)", async () => {
    const input = {
      type: "oauth" as const,
      provider: "notion",
      label: "Notion",
      secret: { access_token: "notion-token" },
    };

    const resultA = await adapter.upsert(input, "user-a");
    const resultC = await adapter.upsert(input, "user-c");

    expect(resultC.id).not.toBe(resultA.id);
    expect(await adapter.get(resultA.id, "user-a")).not.toBeNull();
    expect(await adapter.get(resultC.id, "user-c")).not.toBeNull();
    expect(await adapter.get(resultA.id, "user-c")).toBeNull();
    expect(await adapter.get(resultC.id, "user-a")).toBeNull();
  });

  it("list only returns current user credentials", async () => {
    const input = {
      type: "oauth" as const,
      provider: "list-test",
      label: "List Test Cred",
      secret: { access_token: "list-secret" },
    };
    await adapter.save(input, "list-user-a");
    await adapter.save(input, "list-user-b");

    const listA = await adapter.list("oauth", "list-user-a");
    const listB = await adapter.list("oauth", "list-user-b");

    expect(listA.length).toBeGreaterThanOrEqual(1);
    expect(listB.length).toBeGreaterThanOrEqual(1);
    expect(listA.every((c) => c.type === "oauth")).toBe(true);

    const idsA = new Set(listA.map((c) => c.id));
    expect(listB.some((c) => idsA.has(c.id))).toBe(false);
  });

  it("list returns empty array for non-existent user", async () => {
    expect(await adapter.list("oauth", "nonexistent-user-xyz")).toEqual([]);
  });

  it("list filters by credential type", async () => {
    await adapter.save(
      {
        type: "oauth",
        provider: "type-filter-oauth",
        label: "OAuth Cred",
        secret: { access_token: "oauth-secret" },
      },
      "type-filter-user",
    );
    await adapter.save(
      {
        type: "apikey",
        provider: "type-filter-apikey",
        label: "API Key Cred",
        secret: { key: "apikey-secret" },
      },
      "type-filter-user",
    );

    const oauthList = await adapter.list("oauth", "type-filter-user");
    expect(oauthList).toHaveLength(1);
    expect(oauthList[0]).toMatchObject({ type: "oauth", provider: "type-filter-oauth" });

    const apikeyList = await adapter.list("apikey", "type-filter-user");
    expect(apikeyList).toHaveLength(1);
    expect(apikeyList[0]).toMatchObject({ type: "apikey", provider: "type-filter-apikey" });
  });

  it("list excludes secret field from returned summaries", async () => {
    await adapter.save(
      {
        type: "oauth",
        provider: "secret-exclusion-test",
        label: "Secret Test",
        secret: { access_token: "super-secret-token", refresh_token: "also-secret" },
      },
      "secret-exclusion-user",
    );

    const list = await adapter.list("oauth", "secret-exclusion-user");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("secret");
    expect(list[0]).toMatchObject({
      provider: "secret-exclusion-test",
      label: "Secret Test",
      id: expect.any(String),
      metadata: expect.any(Object),
    });
  });

  it("findByProviderAndExternalId returns matching credential", async () => {
    await adapter.save(
      {
        type: "oauth",
        provider: "github-oauth",
        label: "GitHub",
        secret: { access_token: "gh-token", externalId: "user-12345" },
      },
      "external-id-user",
    );

    expect(
      await adapter.findByProviderAndExternalId("github-oauth", "user-12345", "external-id-user"),
    ).toMatchObject({
      provider: "github-oauth",
      secret: { externalId: "user-12345", access_token: "gh-token" },
    });
  });

  it("findByProviderAndExternalId returns null if no match", async () => {
    await adapter.save(
      {
        type: "oauth",
        provider: "no-external-id",
        label: "No External ID",
        secret: { access_token: "token" },
      },
      "external-id-user-2",
    );

    expect(
      await adapter.findByProviderAndExternalId(
        "no-external-id",
        "nonexistent-id",
        "external-id-user-2",
      ),
    ).toBeNull();
  });

  it("findByProviderAndExternalId respects tenant isolation", async () => {
    await adapter.save(
      {
        type: "oauth",
        provider: "tenant-iso-provider",
        label: "Tenant Iso",
        secret: { access_token: "token", externalId: "tenant-ext-123" },
      },
      "tenant-iso-owner",
    );

    expect(
      await adapter.findByProviderAndExternalId(
        "tenant-iso-provider",
        "tenant-ext-123",
        "different-user",
      ),
    ).toBeNull();
  });

  it("findByProviderAndExternalId returns null for non-existent user", async () => {
    expect(
      await adapter.findByProviderAndExternalId(
        "any-provider",
        "any-external-id",
        "nonexistent-user-findby",
      ),
    ).toBeNull();
  });

  it("delete removes credential", async () => {
    const { id } = await adapter.save(
      {
        type: "oauth",
        provider: "delete-test",
        label: "Delete Me",
        secret: { access_token: "to-be-deleted" },
      },
      "delete-user",
    );

    expect(await adapter.get(id, "delete-user")).not.toBeNull();
    await adapter.delete(id, "delete-user");
    expect(await adapter.get(id, "delete-user")).toBeNull();
  });

  it("delete succeeds silently if credential not found", async () => {
    await expect(adapter.delete("nonexistent-id", "delete-user-2")).resolves.toBeUndefined();
  });

  it("delete respects tenant isolation (can only delete own credentials)", async () => {
    const { id } = await adapter.save(
      {
        type: "oauth",
        provider: "delete-tenant-test",
        label: "Tenant Delete",
        secret: { access_token: "tenant-secret" },
      },
      "delete-owner",
    );

    await adapter.delete(id, "delete-attacker");
    expect(await adapter.get(id, "delete-owner")).not.toBeNull();
  });

  it("delete: promotes next-oldest credential when deleting the default", async () => {
    const user = "delete-promote-user";
    const first = await adapter.save(
      { type: "oauth", provider: "delete-promote", label: "First", secret: { token: "1" } },
      user,
    );
    const second = await adapter.save(
      { type: "oauth", provider: "delete-promote", label: "Second", secret: { token: "2" } },
      user,
    );

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    await adapter.delete(first.id, user);

    const promoted = await adapter.get(second.id, user);
    expect(promoted?.isDefault).toBe(true);
  });

  it("delete: does not promote when deleting a non-default credential", async () => {
    const user = "delete-nondefault-user";
    const first = await adapter.save(
      { type: "oauth", provider: "delete-nopromotion", label: "Default", secret: { token: "1" } },
      user,
    );
    const second = await adapter.save(
      { type: "oauth", provider: "delete-nopromotion", label: "Other", secret: { token: "2" } },
      user,
    );

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    await adapter.delete(second.id, user);

    const remaining = await adapter.get(first.id, user);
    expect(remaining?.isDefault).toBe(true);
  });

  it("delete: no promotion when last credential for provider is deleted", async () => {
    const user = "delete-last-user";
    const only = await adapter.save(
      { type: "oauth", provider: "delete-lastprovider", label: "Only", secret: { token: "1" } },
      user,
    );

    await adapter.delete(only.id, user);

    expect(await adapter.get(only.id, user)).toBeNull();
  });

  it("updateMetadata updates displayName and returns updated metadata", async () => {
    const { id, metadata } = await adapter.save(
      {
        type: "oauth",
        provider: "meta-update",
        label: "Meta Test",
        secret: { access_token: "original-secret" },
      },
      "meta-user",
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await adapter.updateMetadata(id, { displayName: "My Custom Name" }, "meta-user");

    expect(result.createdAt).toBe(metadata.createdAt);
    expect(result.updatedAt).not.toBe(metadata.updatedAt);

    expect(await adapter.get(id, "meta-user")).toMatchObject({
      displayName: "My Custom Name",
      secret: { access_token: "original-secret" },
    });
  });

  it("updateMetadata throws for non-existent credential", async () => {
    await expect(
      adapter.updateMetadata("nonexistent", { displayName: "Test" }, "meta-user-2"),
    ).rejects.toThrow("Credential not found");
  });

  it("updateMetadata throws for wrong user", async () => {
    const { id } = await adapter.save(
      {
        type: "oauth",
        provider: "meta-tenant-test",
        label: "Meta Tenant",
        secret: { access_token: "tenant-secret" },
      },
      "meta-owner",
    );

    await expect(
      adapter.updateMetadata(id, { displayName: "Test" }, "meta-attacker"),
    ).rejects.toThrow("Credential not found");
  });

  describe("auto-default logic", () => {
    it("save: first credential for a provider gets isDefault = true", async () => {
      const result = await adapter.save(
        {
          type: "apikey",
          provider: "auto-default-provider",
          label: "First Key",
          secret: { key: "key-1" },
        },
        "auto-default-user",
      );

      expect(result.isDefault).toBe(true);

      const cred = await adapter.get(result.id, "auto-default-user");
      expect(cred?.isDefault).toBe(true);
    });

    it("save: second credential for same provider gets isDefault = false", async () => {
      const result = await adapter.save(
        {
          type: "apikey",
          provider: "auto-default-provider",
          label: "Second Key",
          secret: { key: "key-2" },
        },
        "auto-default-user",
      );

      expect(result.isDefault).toBe(false);

      const cred = await adapter.get(result.id, "auto-default-user");
      expect(cred?.isDefault).toBe(false);
    });

    it("save: first credential for a different provider also gets isDefault = true", async () => {
      const result = await adapter.save(
        {
          type: "apikey",
          provider: "auto-default-other-provider",
          label: "Other Provider Key",
          secret: { key: "other-key" },
        },
        "auto-default-user",
      );

      expect(result.isDefault).toBe(true);
    });

    it("upsert: creates new credential as default when no others for provider", async () => {
      const result = await adapter.upsert(
        {
          type: "oauth",
          provider: "upsert-default-provider",
          label: "First OAuth",
          secret: { access_token: "token-1" },
        },
        "upsert-default-user",
      );

      expect(result.isDefault).toBe(true);
    });

    it("upsert: updates non-default credential to default when no other default exists", async () => {
      // Create two credentials for same provider
      const first = await adapter.save(
        {
          type: "oauth",
          provider: "upsert-promote-provider",
          label: "First",
          secret: { access_token: "t1" },
        },
        "upsert-promote-user",
      );
      const second = await adapter.save(
        {
          type: "oauth",
          provider: "upsert-promote-provider",
          label: "Second",
          secret: { access_token: "t2" },
        },
        "upsert-promote-user",
      );

      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);

      // Delete the default credential
      await adapter.delete(first.id, "upsert-promote-user");

      // Re-auth into the non-default — should promote to default
      const result = await adapter.upsert(
        {
          type: "oauth",
          provider: "upsert-promote-provider",
          label: "Second",
          secret: { access_token: "t2-refreshed" },
        },
        "upsert-promote-user",
      );

      expect(result.id).toBe(second.id);
      expect(result.isDefault).toBe(true);
    });

    it("upsert: preserves non-default when another default exists", async () => {
      // Create default credential
      const first = await adapter.save(
        {
          type: "oauth",
          provider: "upsert-preserve-provider",
          label: "Default",
          secret: { access_token: "t1" },
        },
        "upsert-preserve-user",
      );
      // Create non-default
      const second = await adapter.save(
        {
          type: "oauth",
          provider: "upsert-preserve-provider",
          label: "Non-Default",
          secret: { access_token: "t2" },
        },
        "upsert-preserve-user",
      );

      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);

      // Re-auth into the non-default — should stay non-default
      const result = await adapter.upsert(
        {
          type: "oauth",
          provider: "upsert-preserve-provider",
          label: "Non-Default",
          secret: { access_token: "t2-refreshed" },
        },
        "upsert-preserve-user",
      );

      expect(result.id).toBe(second.id);
      expect(result.isDefault).toBe(false);
    });
  });

  describe("setDefault", () => {
    it("swaps default from credential A to credential B", async () => {
      const user = "setdefault-swap-user";
      const a = await adapter.save(
        { type: "apikey", provider: "swap-provider", label: "A", secret: { key: "a" } },
        user,
      );
      const b = await adapter.save(
        { type: "apikey", provider: "swap-provider", label: "B", secret: { key: "b" } },
        user,
      );

      expect(a.isDefault).toBe(true);
      expect(b.isDefault).toBe(false);

      await adapter.setDefault(b.id, user);

      const credA = await adapter.get(a.id, user);
      const credB = await adapter.get(b.id, user);
      expect(credA?.isDefault).toBe(false);
      expect(credB?.isDefault).toBe(true);
    });

    it("no-op if credential is already the default", async () => {
      const user = "setdefault-noop-user";
      const a = await adapter.save(
        { type: "apikey", provider: "noop-provider", label: "A", secret: { key: "a" } },
        user,
      );

      expect(a.isDefault).toBe(true);

      await adapter.setDefault(a.id, user);

      const cred = await adapter.get(a.id, user);
      expect(cred?.isDefault).toBe(true);
    });

    it("throws for non-existent credential ID", async () => {
      const user = "setdefault-missing-user";
      await adapter.save(
        { type: "apikey", provider: "missing-provider", label: "A", secret: { key: "a" } },
        user,
      );

      await expect(adapter.setDefault("nonexistent-id", user)).rejects.toThrow(
        "Credential not found",
      );
    });

    it("throws for wrong userId (tenant isolation)", async () => {
      const owner = "setdefault-tenant-owner";
      const attacker = "setdefault-tenant-attacker";
      const { id } = await adapter.save(
        { type: "apikey", provider: "tenant-sd-provider", label: "A", secret: { key: "a" } },
        owner,
      );

      await expect(adapter.setDefault(id, attacker)).rejects.toThrow("Credential not found");

      // Original credential unchanged
      const cred = await adapter.get(id, owner);
      expect(cred?.isDefault).toBe(true);
    });

    it("does not affect credentials from a different provider", async () => {
      const user = "setdefault-cross-provider-user";
      const providerA = await adapter.save(
        { type: "apikey", provider: "provider-x", label: "X", secret: { key: "x" } },
        user,
      );
      const providerB = await adapter.save(
        { type: "apikey", provider: "provider-y", label: "Y", secret: { key: "y" } },
        user,
      );

      // Both are defaults for their respective providers
      expect(providerA.isDefault).toBe(true);
      expect(providerB.isDefault).toBe(true);

      // Add a second credential for provider-x and swap default
      const providerA2 = await adapter.save(
        { type: "apikey", provider: "provider-x", label: "X2", secret: { key: "x2" } },
        user,
      );
      await adapter.setDefault(providerA2.id, user);

      // provider-y default should be untouched
      const credY = await adapter.get(providerB.id, user);
      expect(credY?.isDefault).toBe(true);
    });
  });

  describe("getDefaultByProvider", () => {
    it("returns default credential with decrypted secret", async () => {
      const user = "getdefault-found-user";
      const saved = await adapter.save(
        {
          type: "oauth",
          provider: "getdefault-provider",
          label: "OAuth",
          secret: { access_token: "tok-123" },
        },
        user,
      );

      expect(saved.isDefault).toBe(true);

      const result = await adapter.getDefaultByProvider("getdefault-provider", user);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(saved.id);
      expect(result?.isDefault).toBe(true);
      expect(result?.secret).toEqual({ access_token: "tok-123" });
    });

    it("returns null when no default exists for provider", async () => {
      const user = "getdefault-null-user";
      const result = await adapter.getDefaultByProvider("nonexistent-provider", user);
      expect(result).toBeNull();
    });

    it("returns null for wrong userId (tenant isolation)", async () => {
      const owner = "getdefault-tenant-owner";
      await adapter.save(
        {
          type: "oauth",
          provider: "getdefault-tenant-prov",
          label: "OAuth",
          secret: { access_token: "tok" },
        },
        owner,
      );

      const result = await adapter.getDefaultByProvider("getdefault-tenant-prov", "different-user");
      expect(result).toBeNull();
    });

    it("reflects setDefault swap", async () => {
      const user = "getdefault-swap-user";
      const a = await adapter.save(
        { type: "apikey", provider: "getdefault-swap-prov", label: "A", secret: { key: "a" } },
        user,
      );
      const b = await adapter.save(
        { type: "apikey", provider: "getdefault-swap-prov", label: "B", secret: { key: "b" } },
        user,
      );

      // Before swap — A is default
      const before = await adapter.getDefaultByProvider("getdefault-swap-prov", user);
      expect(before?.id).toBe(a.id);

      // Swap default to B
      await adapter.setDefault(b.id, user);

      const after = await adapter.getDefaultByProvider("getdefault-swap-prov", user);
      expect(after?.id).toBe(b.id);
      expect(after?.secret).toEqual({ key: "b" });
    });
  });
});
