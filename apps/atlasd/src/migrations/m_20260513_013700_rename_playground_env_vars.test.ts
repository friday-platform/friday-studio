import { describe, expect, test } from "vitest";
import { rewriteEnv } from "./m_20260513_013700_rename_playground_env_vars.ts";

describe("rewriteEnv (playground → studio-ui env var migration)", () => {
  describe("FRIDAY_PORT_PLAYGROUND → FRIDAY_PORT_STUDIO_UI", () => {
    test("rewrites the legacy key, preserves the value", () => {
      const input = "FRIDAY_PORT_PLAYGROUND=15200\n";
      expect(rewriteEnv(input)).toBe("FRIDAY_PORT_STUDIO_UI=15200\n");
    });

    test("preserves custom user value (not just the installer default)", () => {
      const input = "FRIDAY_PORT_PLAYGROUND=25200\n";
      expect(rewriteEnv(input)).toBe("FRIDAY_PORT_STUDIO_UI=25200\n");
    });

    test("no-op when only the new key is present", () => {
      const input = "FRIDAY_PORT_STUDIO_UI=15200\n";
      expect(rewriteEnv(input)).toBe(input);
    });

    test("legacy value wins when both keys are present", () => {
      // This is the post-installer state: ensure_platform_env_vars
      // seeded FRIDAY_PORT_STUDIO_UI=15200 (default) before migration,
      // but the user's customised legacy value should survive.
      const input = "FRIDAY_PORT_STUDIO_UI=15200\nFRIDAY_PORT_PLAYGROUND=25200\n";
      expect(rewriteEnv(input)).toBe("FRIDAY_PORT_STUDIO_UI=25200\n");
    });

    test("legacy line position is preserved when new-key line is dropped", () => {
      // Legacy appears AFTER the new key in the file — the rewritten
      // line stays at the legacy's original position; the new-key line
      // is removed from where it was.
      const input = [
        "FRIDAY_ENV=dev",
        "FRIDAY_PORT_STUDIO_UI=15200",
        "FRIDAY_PORT_FRIDAY=18080",
        "FRIDAY_PORT_PLAYGROUND=25200",
        "",
      ].join("\n");
      expect(rewriteEnv(input)).toBe(
        ["FRIDAY_ENV=dev", "FRIDAY_PORT_FRIDAY=18080", "FRIDAY_PORT_STUDIO_UI=25200", ""].join(
          "\n",
        ),
      );
    });
  });

  describe("PLAYGROUND_PORT → STUDIO_UI_PORT", () => {
    test("rewrites the legacy key, preserves the value", () => {
      const input = "PLAYGROUND_PORT=5200\n";
      expect(rewriteEnv(input)).toBe("STUDIO_UI_PORT=5200\n");
    });

    test("legacy value wins when both are present", () => {
      const input = "STUDIO_UI_PORT=5200\nPLAYGROUND_PORT=6300\n";
      expect(rewriteEnv(input)).toBe("STUDIO_UI_PORT=6300\n");
    });
  });

  describe("PLAYGROUND_HOST → STUDIO_UI_HOST", () => {
    test("rewrites the legacy key, preserves the value", () => {
      const input = "PLAYGROUND_HOST=0.0.0.0\n";
      expect(rewriteEnv(input)).toBe("STUDIO_UI_HOST=0.0.0.0\n");
    });

    test("legacy value wins when both are present", () => {
      const input = "STUDIO_UI_HOST=127.0.0.1\nPLAYGROUND_HOST=0.0.0.0\n";
      expect(rewriteEnv(input)).toBe("STUDIO_UI_HOST=0.0.0.0\n");
    });
  });

  describe("multiple legacy keys in one file", () => {
    test("rewrites all three pairs independently", () => {
      const input = [
        "FRIDAY_PORT_PLAYGROUND=15200",
        "PLAYGROUND_PORT=5200",
        "PLAYGROUND_HOST=0.0.0.0",
        "",
      ].join("\n");
      expect(rewriteEnv(input)).toBe(
        ["FRIDAY_PORT_STUDIO_UI=15200", "STUDIO_UI_PORT=5200", "STUDIO_UI_HOST=0.0.0.0", ""].join(
          "\n",
        ),
      );
    });

    test("rewrites only the pairs whose legacy key is set", () => {
      // FRIDAY_PORT_PLAYGROUND set, PLAYGROUND_PORT not set, PLAYGROUND_HOST set
      const input = ["FRIDAY_PORT_PLAYGROUND=15200", "PLAYGROUND_HOST=0.0.0.0", ""].join("\n");
      expect(rewriteEnv(input)).toBe(
        ["FRIDAY_PORT_STUDIO_UI=15200", "STUDIO_UI_HOST=0.0.0.0", ""].join("\n"),
      );
    });
  });

  describe("formatting + edge cases", () => {
    test("preserves surrounding lines, comments, and blank lines", () => {
      const input = [
        "# Friday Studio installer-written defaults",
        "",
        "FRIDAY_ENV=dev",
        "FRIDAY_PORT_FRIDAY=18080",
        "FRIDAY_PORT_PLAYGROUND=15200",
        "FRIDAY_PORT_WEBHOOK_TUNNEL=19090",
        "",
        "# user override below",
        'ANTHROPIC_API_KEY="sk-ant-xxxxx"',
        "",
      ].join("\n");
      expect(rewriteEnv(input)).toBe(
        [
          "# Friday Studio installer-written defaults",
          "",
          "FRIDAY_ENV=dev",
          "FRIDAY_PORT_FRIDAY=18080",
          "FRIDAY_PORT_STUDIO_UI=15200",
          "FRIDAY_PORT_WEBHOOK_TUNNEL=19090",
          "",
          "# user override below",
          'ANTHROPIC_API_KEY="sk-ant-xxxxx"',
          "",
        ].join("\n"),
      );
    });

    test("no-op when no legacy keys are present", () => {
      const input = "FRIDAY_ENV=dev\nFRIDAY_PORT_FRIDAY=18080\n";
      expect(rewriteEnv(input)).toBe(input);
    });

    test("no-op on empty file", () => {
      expect(rewriteEnv("")).toBe("");
    });

    test("ignores commented-out legacy keys", () => {
      const input = "# FRIDAY_PORT_PLAYGROUND=15200\nFRIDAY_PORT_STUDIO_UI=25200\n";
      expect(rewriteEnv(input)).toBe(input);
    });

    test("idempotent: second pass leaves output unchanged", () => {
      const once = rewriteEnv(
        "FRIDAY_PORT_PLAYGROUND=15200\nPLAYGROUND_PORT=5200\nPLAYGROUND_HOST=0.0.0.0\n",
      );
      expect(rewriteEnv(once)).toBe(once);
    });

    test("preserves quoted values", () => {
      const input = 'FRIDAY_PORT_PLAYGROUND="15200"\n';
      expect(rewriteEnv(input)).toBe('FRIDAY_PORT_STUDIO_UI="15200"\n');
    });
  });
});
