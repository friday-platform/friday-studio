import { describe, expect, it } from "vitest";
import { buildVarsOverride } from "./env-set-tool-card.ts";

describe("buildVarsOverride", () => {
  it("uses the user-typed value when present", () => {
    const out = buildVarsOverride([["API_KEY", ""]], { API_KEY: "sk-real" });
    expect(out).toEqual({ API_KEY: "sk-real" });
  });

  it("falls back to the proposed value when no user value is provided", () => {
    const out = buildVarsOverride([["API_KEY", "sk-proposed"]], {});
    expect(out).toEqual({ API_KEY: "sk-proposed" });
  });

  it("emits an empty string when neither user nor proposed has a value", () => {
    const out = buildVarsOverride([["API_KEY", ""]], {});
    expect(out).toEqual({ API_KEY: "" });
  });

  it("includes non-secret keys", () => {
    const out = buildVarsOverride([["PORT", "3000"]], { PORT: "9000" });
    expect(out).toEqual({ PORT: "9000" });
  });

  it("returns the user value for every key in a mixed payload", () => {
    const out = buildVarsOverride(
      [
        ["PORT", "3000"],
        ["API_KEY", ""],
        ["BASE_URL", "https://x"],
        ["DB_PASSWORD", ""],
      ],
      { API_KEY: "sk-real", DB_PASSWORD: "hunter2", PORT: "9000" },
    );
    expect(out).toEqual({
      PORT: "9000",
      API_KEY: "sk-real",
      BASE_URL: "https://x",
      DB_PASSWORD: "hunter2",
    });
  });

  it("returns an empty object for empty entries", () => {
    expect(buildVarsOverride([], {})).toEqual({});
  });

  it("preserves leading/trailing whitespace on the sent value", () => {
    const out = buildVarsOverride([["API_KEY", ""]], { API_KEY: "  sk-real  " });
    expect(out).toEqual({ API_KEY: "  sk-real  " });
  });

  it("preserves whitespace-only user values", () => {
    const out = buildVarsOverride([["API_KEY", ""]], { API_KEY: "   " });
    expect(out).toEqual({ API_KEY: "   " });
  });
});
