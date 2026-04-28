import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppInstallCredentialSecretSchema, defineApiKeyProvider } from "./types.ts";

describe("AppInstallCredentialSecretSchema", () => {
  describe("legacy Slack credential normalization", () => {
    it("adds platform field to legacy Slack credentials", () => {
      const legacySlackCredential = {
        externalId: "T01234567",
        access_token: "xoxb-test-token",
        slack: { appId: "A01234567" },
      };

      const result = AppInstallCredentialSecretSchema.safeParse(legacySlackCredential);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe("slack");
      }
    });

    it("preserves platform field on new Slack credentials", () => {
      const newSlackCredential = {
        platform: "slack" as const,
        externalId: "T01234567",
        access_token: "xoxb-test-token",
      };

      const result = AppInstallCredentialSecretSchema.safeParse(newSlackCredential);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe("slack");
      }
    });
  });

  it("rejects credentials with unknown platform", () => {
    const result = AppInstallCredentialSecretSchema.safeParse({
      platform: "unknown",
      access_token: "token",
      externalId: "ext-1",
    });

    expect(result.success).toBe(false);
  });
});

describe("defineApiKeyProvider autoFields", () => {
  it("provider without autoFields stays backward-compatible", () => {
    const provider = defineApiKeyProvider({
      id: "no-auto",
      displayName: "No Auto",
      description: "Provider without auto-generated fields",
      secretSchema: z.object({ api_key: z.string() }),
      setupInstructions: "Paste your key.",
    });

    expect(provider.autoFields).toBeUndefined();
  });

  it("provider with autoFields exposes a hook that returns generated values", () => {
    const provider = defineApiKeyProvider({
      id: "with-auto",
      displayName: "With Auto",
      description: "Provider with auto-generated fields",
      secretSchema: z.object({ user_field: z.string() }),
      autoFields: () => ({ generated: "abc123" }),
      setupInstructions: "Paste your value.",
    });

    expect(provider.autoFields).toBeDefined();
    expect(provider.autoFields?.()).toEqual({ generated: "abc123" });
  });

  it("merging public-schema parse + autoFields satisfies a full schema", () => {
    const provider = defineApiKeyProvider({
      id: "merge-check",
      displayName: "Merge Check",
      description: "Verifies the merge produces a complete stored shape",
      secretSchema: z.object({ user_field: z.string().min(1) }),
      autoFields: () => ({ auto_field: "server-chosen-value" }),
      setupInstructions: "...",
    });

    const userInput = provider.secretSchema.parse({ user_field: "user-typed" });
    const merged = { ...userInput, ...provider.autoFields?.() };

    const fullSchema = z.object({ user_field: z.string().min(1), auto_field: z.string().min(1) });
    expect(fullSchema.safeParse(merged).success).toBe(true);
  });

  it("autoFields override user-supplied values for the same key", () => {
    const provider = defineApiKeyProvider({
      id: "defense-in-depth",
      displayName: "Defense In Depth",
      description: "Auto fields must override user input",
      secretSchema: z.object({ user_field: z.string() }),
      autoFields: () => ({ secret_field: "server-value" }),
      setupInstructions: "...",
    });

    const userSupplied = { user_field: "u", secret_field: "client-tried-to-set-this" };
    const merged = { ...userSupplied, ...provider.autoFields?.() };
    expect(merged.secret_field).toBe("server-value");
  });
});
