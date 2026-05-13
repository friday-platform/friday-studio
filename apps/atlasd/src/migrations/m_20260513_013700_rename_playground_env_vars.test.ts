import { describe, expect, test } from "vitest";
import { rewriteEnv } from "./m_20260513_013700_rename_playground_env_vars.ts";

describe("rewriteEnv (playground → studio-ui env var migration)", () => {
  test("rewrites the legacy key, preserves the value", () => {
    const input = "FRIDAY_PORT_PLAYGROUND=15200\n";
    expect(rewriteEnv(input)).toBe("FRIDAY_PORT_STUDIO_UI=15200\n");
  });

  test("preserves surrounding lines + comments + blank lines", () => {
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

  test("preserves custom user value (not just the installer default)", () => {
    const input = "FRIDAY_PORT_PLAYGROUND=25200\n";
    expect(rewriteEnv(input)).toBe("FRIDAY_PORT_STUDIO_UI=25200\n");
  });

  test("no-op when only the new key is present", () => {
    const input = "FRIDAY_PORT_STUDIO_UI=15200\n";
    expect(rewriteEnv(input)).toBe(input);
  });

  test("drops the legacy key when both are present (new key wins)", () => {
    const input = "FRIDAY_PORT_STUDIO_UI=15200\nFRIDAY_PORT_PLAYGROUND=25200\n";
    expect(rewriteEnv(input)).toBe("FRIDAY_PORT_STUDIO_UI=15200\n");
  });

  test("no-op when neither key is present", () => {
    const input = "FRIDAY_ENV=dev\nFRIDAY_PORT_FRIDAY=18080\n";
    expect(rewriteEnv(input)).toBe(input);
  });

  test("no-op on empty file", () => {
    expect(rewriteEnv("")).toBe("");
  });

  test("ignores commented-out legacy key", () => {
    const input = "# FRIDAY_PORT_PLAYGROUND=15200\nFRIDAY_PORT_STUDIO_UI=25200\n";
    expect(rewriteEnv(input)).toBe(input);
  });

  test("idempotent: second pass leaves output unchanged", () => {
    const once = rewriteEnv("FRIDAY_PORT_PLAYGROUND=15200\n");
    expect(rewriteEnv(once)).toBe(once);
  });

  test("preserves quoted values", () => {
    const input = 'FRIDAY_PORT_PLAYGROUND="15200"\n';
    expect(rewriteEnv(input)).toBe('FRIDAY_PORT_STUDIO_UI="15200"\n');
  });
});
