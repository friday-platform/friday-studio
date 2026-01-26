import { describe, expect, it } from "vitest";
import { AppInstallCredentialSecretSchema } from "./types.ts";

describe("AppInstallCredentialSecretSchema", () => {
  describe("legacy Slack credential normalization", () => {
    it("adds platform field to legacy Slack credentials", () => {
      const legacySlackCredential = {
        externalId: "T01234567",
        access_token: "xoxb-test-token",
        token_type: "bot",
        slack: {
          botUserId: "B01234567",
          appId: "A01234567",
          teamId: "T01234567",
          teamName: "Test Workspace",
          scopes: ["chat:write"],
        },
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
        token_type: "bot",
      };

      const result = AppInstallCredentialSecretSchema.safeParse(newSlackCredential);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe("slack");
      }
    });

    it("parses GitHub credentials without modification", () => {
      const githubCredential = {
        platform: "github" as const,
        externalId: "12345",
        access_token: "ghs_test-token",
        expires_at: Date.now() + 3600000,
        github: { installationId: 12345, organizationName: "test-org", organizationId: 67890 },
      };

      const result = AppInstallCredentialSecretSchema.safeParse(githubCredential);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe("github");
      }
    });

    it("rejects invalid credentials", () => {
      const invalidCredential = { platform: "invalid", access_token: "test" };

      const result = AppInstallCredentialSecretSchema.safeParse(invalidCredential);

      expect(result.success).toBe(false);
    });
  });
});
