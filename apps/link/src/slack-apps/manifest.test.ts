import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.ts";

describe("buildManifest", () => {
  const defaults = {
    appName: "My Workspace",
    description: "A workspace for testing",
    callbackUrl: "https://link.example.com/v1/callback/slack-app",
  };

  it("produces valid manifest structure", () => {
    const manifest = buildManifest(defaults);

    expect(manifest).toMatchObject({
      display_information: { name: "My Workspace", description: "A workspace for testing" },
      features: { bot_user: { display_name: "my_workspace", always_online: true } },
      oauth_config: {
        scopes: { bot: expect.any(Array) },
        redirect_urls: ["https://link.example.com/v1/callback/slack-app"],
      },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("does not include event_subscriptions", () => {
    const manifest = buildManifest(defaults);

    expect(manifest.settings).not.toHaveProperty("event_subscriptions");
  });

  it("includes all required bot scopes", () => {
    const manifest = buildManifest(defaults);
    const scopes = manifest.oauth_config.scopes.bot;

    const required = [
      "chat:write",
      "chat:write.public",
      "app_mentions:read",
      "channels:history",
      "channels:read",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
      "mpim:write",
      "users:read",
    ];

    for (const scope of required) {
      expect(scopes).toContain(scope);
    }
    expect(scopes).toHaveLength(required.length);
  });

  describe("name truncation", () => {
    it("truncates name to 35 characters", () => {
      const manifest = buildManifest({ ...defaults, appName: "A".repeat(50) });

      expect(manifest.display_information.name).toHaveLength(35);
    });

    it("preserves name under 35 characters", () => {
      const manifest = buildManifest({ ...defaults, appName: "Short Name" });

      expect(manifest.display_information.name).toBe("Short Name");
    });
  });

  describe("description truncation", () => {
    it("truncates description to 120 characters", () => {
      const manifest = buildManifest({ ...defaults, description: "D".repeat(200) });

      expect(manifest.display_information.description).toHaveLength(120);
    });
  });

  describe("callback URL", () => {
    it("uses the provided callback URL in redirect_urls", () => {
      const manifest = buildManifest({
        ...defaults,
        callbackUrl: "https://custom.example.com/v1/callback/slack-app",
      });

      expect(manifest.oauth_config.redirect_urls).toEqual([
        "https://custom.example.com/v1/callback/slack-app",
      ]);
    });
  });

  describe("display_name snake_case conversion", () => {
    const cases = [
      { name: "spaces to underscores", input: "My Workspace", expected: "my_workspace" },
      { name: "uppercase to lowercase", input: "LOUD NAME", expected: "loud_name" },
      { name: "preserves hyphens", input: "my-workspace", expected: "my-workspace" },
      { name: "preserves dots", input: "my.workspace", expected: "my.workspace" },
      { name: "preserves underscores", input: "my_workspace", expected: "my_workspace" },
      { name: "preserves digits", input: "workspace 42", expected: "workspace_42" },
      {
        name: "strips disallowed characters",
        input: "My Workspace! @#$%",
        expected: "my_workspace",
      },
      { name: "collapses multiple spaces", input: "My   Workspace", expected: "my_workspace" },
      {
        name: "trims leading/trailing spaces",
        input: "  My Workspace  ",
        expected: "my_workspace",
      },
    ] as const;

    it.each(cases)("$name: '$input' -> '$expected'", ({ input, expected }) => {
      const manifest = buildManifest({ ...defaults, appName: input });

      expect(manifest.features.bot_user.display_name).toBe(expected);
    });

    it("truncates display_name to 80 characters", () => {
      const manifest = buildManifest({ ...defaults, appName: "a".repeat(100) });

      expect(manifest.features.bot_user.display_name).toHaveLength(80);
    });
  });
});
