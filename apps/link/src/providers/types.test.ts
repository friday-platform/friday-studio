import { describe, expect, it } from "vitest";
import { AppInstallCredentialSecretSchema } from "./types.ts";

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
