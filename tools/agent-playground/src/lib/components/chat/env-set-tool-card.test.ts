import { describe, expect, it } from "vitest";
import { buildVarsOverride } from "./env-set-tool-card.ts";

const isSecret = (k: string) => /password|secret|token|key|credential/i.test(k);

describe("buildVarsOverride", () => {
  it("uses the user-typed value for a secret key", () => {
    const out = buildVarsOverride(
      [["API_KEY", ""]],
      { API_KEY: "sk-real" },
      isSecret,
    );
    expect(out).toEqual({ API_KEY: "sk-real" });
  });

  it("falls back to the proposed value when no user value is provided", () => {
    const out = buildVarsOverride([["API_KEY", "sk-proposed"]], {}, isSecret);
    expect(out).toEqual({ API_KEY: "sk-proposed" });
  });

  it("emits an empty string when neither user nor proposed has a value", () => {
    const out = buildVarsOverride([["API_KEY", ""]], {}, isSecret);
    expect(out).toEqual({ API_KEY: "" });
  });

  it("omits non-secret keys", () => {
    const out = buildVarsOverride(
      [["PORT", "3000"]],
      { PORT: "9000" },
      isSecret,
    );
    expect(out).toEqual({});
  });

  it("only includes secret keys in a mixed payload", () => {
    const out = buildVarsOverride(
      [
        ["PORT", "3000"],
        ["API_KEY", ""],
        ["BASE_URL", "https://x"],
        ["DB_PASSWORD", ""],
      ],
      { API_KEY: "sk-real", DB_PASSWORD: "hunter2" },
      isSecret,
    );
    expect(out).toEqual({ API_KEY: "sk-real", DB_PASSWORD: "hunter2" });
  });

  it("returns an empty object for empty entries", () => {
    expect(buildVarsOverride([], {}, isSecret)).toEqual({});
  });

  it("preserves leading/trailing whitespace on the sent value", () => {
    const out = buildVarsOverride(
      [["API_KEY", ""]],
      { API_KEY: "  sk-real  " },
      isSecret,
    );
    expect(out).toEqual({ API_KEY: "  sk-real  " });
  });

  it("preserves whitespace-only user values", () => {
    const out = buildVarsOverride(
      [["API_KEY", ""]],
      { API_KEY: "   " },
      isSecret,
    );
    expect(out).toEqual({ API_KEY: "   " });
  });
});
