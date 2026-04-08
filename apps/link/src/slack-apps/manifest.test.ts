import { describe, expect, it } from "vitest";
import { BOT_SCOPES, buildManifest } from "./manifest.ts";

describe("buildManifest", () => {
  const defaults = {
    appName: "My Workspace",
    description: "A workspace for testing",
    callbackUrl: "https://link.example.com/v1/callback/slack-app",
  };

  it("produces a manifest with the expected static shape, scopes, and callback URL", () => {
    const manifest = buildManifest(defaults);

    expect(manifest).toMatchObject({
      display_information: { name: "My Workspace", description: "A workspace for testing" },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: "My Workspace", always_online: true },
      },
      oauth_config: {
        scopes: { bot: [...BOT_SCOPES] },
        redirect_urls: ["https://link.example.com/v1/callback/slack-app"],
      },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
    // event_subscriptions is added later by withEventSubscriptions, never here
    expect(manifest.settings).not.toHaveProperty("event_subscriptions");
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

  describe("display_name sanitization", () => {
    const cases = [
      { name: "preserves casing and spaces", input: "My Workspace", expected: "My Workspace" },
      { name: "preserves uppercase", input: "LOUD NAME", expected: "LOUD NAME" },
      { name: "preserves hyphens", input: "my-workspace", expected: "my-workspace" },
      { name: "preserves dots", input: "my.workspace", expected: "my.workspace" },
      { name: "preserves underscores", input: "my_workspace", expected: "my_workspace" },
      { name: "preserves digits", input: "workspace 42", expected: "workspace 42" },
      {
        name: "strips disallowed characters",
        input: "My Workspace! @#$%",
        expected: "My Workspace",
      },
      { name: "collapses multiple spaces", input: "My   Workspace", expected: "My Workspace" },
      {
        name: "trims leading/trailing spaces",
        input: "  My Workspace  ",
        expected: "My Workspace",
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
