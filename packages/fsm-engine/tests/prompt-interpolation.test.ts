import { describe, expect, it } from "vitest";
import { interpolatePromptPlaceholders } from "../fsm-engine.ts";

/**
 * Regression for the Mustache-style placeholder failure discovered in the
 * knowledge-base with SQLite QA: the workspace-chat meta-agent correctly called
 * the save_entry job tool, the FSM ran, and the agent action failed because
 * its prompt referenced `{{inputs.content}}` / `{{inputs.title}}` and the
 * engine passed the literal template through to the LLM unrendered. The LLM
 * saw the un-interpolated placeholders and refused, even though the actual
 * values were already sitting in the Input section appended below.
 *
 * `interpolatePromptPlaceholders` resolves those references against the
 * prepare-result's `config` object, which now auto-seeds from the triggering
 * signal payload, so "payload in → fields available in prompt" works without
 * requiring authors to write a bespoke code action per job.
 */
describe("interpolatePromptPlaceholders", () => {
  it("returns the prompt unchanged when no prepareResult is available", () => {
    expect(interpolatePromptPlaceholders("Save {{inputs.content}}", undefined)).toBe(
      "Save {{inputs.content}}",
    );
  });

  it("substitutes {{inputs.x}} from prepareResult.config", () => {
    const out = interpolatePromptPlaceholders("Save this: {{inputs.content}}", {
      config: { content: "Hello world" },
    });
    expect(out).toBe("Save this: Hello world");
  });

  it("accepts the legacy {{config.x}} root as an alias", () => {
    const out = interpolatePromptPlaceholders("Save {{config.content}}", {
      config: { content: "Hi" },
    });
    expect(out).toBe("Save Hi");
  });

  it("accepts {{signal.payload.x}} as an alias", () => {
    const out = interpolatePromptPlaceholders("Save {{signal.payload.content}}", {
      config: { content: "Hey" },
    });
    expect(out).toBe("Save Hey");
  });

  it("supports dotted paths into nested objects", () => {
    const out = interpolatePromptPlaceholders("By {{inputs.author.name}}", {
      config: { author: { name: "Ada" } },
    });
    expect(out).toBe("By Ada");
  });

  it("stringifies non-scalar values", () => {
    const out = interpolatePromptPlaceholders("Tags: {{inputs.tags}}", {
      config: { tags: ["a", "b"] },
    });
    expect(out).toBe('Tags: ["a","b"]');
  });

  it("coerces numbers and booleans", () => {
    const out = interpolatePromptPlaceholders("Index {{inputs.i}} ok={{inputs.ok}}", {
      config: { i: 42, ok: true },
    });
    expect(out).toBe("Index 42 ok=true");
  });

  it("leaves unresolved placeholders intact so typos stay visible", () => {
    // Silent blanking would turn "Save {{inputs.contnet}}" (typo) into
    // "Save " — a template bug hidden as an empty prompt. Keep the literal
    // so the agent/author can spot it.
    const out = interpolatePromptPlaceholders("Save {{inputs.contnet}}", {
      config: { content: "Hi" },
    });
    expect(out).toBe("Save {{inputs.contnet}}");
  });

  it("ignores placeholders with no valid identifier shape", () => {
    // Mustache-but-not-ours (`{{ 1 + 2 }}`) shouldn't match the identifier
    // regex and shouldn't throw.
    const out = interpolatePromptPlaceholders("{{ 1 + 2 }} and {{inputs.x}}", {
      config: { x: "hi" },
    });
    expect(out).toBe("{{ 1 + 2 }} and hi");
  });

  it("tolerates whitespace inside the braces", () => {
    const out = interpolatePromptPlaceholders("Save {{  inputs.content  }}", {
      config: { content: "x" },
    });
    expect(out).toBe("Save x");
  });

  it("falls back to the `| default: '...'` literal when the path is missing", () => {
    // Liquid/Jinja convention used by every prompt-templating framework users
    // bring in. Without this, an optional input forced authors to either set
    // every field on every invocation or get a literal `{{...}}` rendered
    // into the agent prompt.
    const out = interpolatePromptPlaceholders(
      "Style: {{inputs.style | default: 'classic SNES/GBA style'}}",
      { config: {} },
    );
    expect(out).toBe("Style: classic SNES/GBA style");
  });

  it("uses the resolved value over the default when both are present", () => {
    const out = interpolatePromptPlaceholders("Style: {{inputs.style | default: 'classic'}}", {
      config: { style: "fantasy anime" },
    });
    expect(out).toBe("Style: fantasy anime");
  });

  it("supports double-quoted default literals", () => {
    const out = interpolatePromptPlaceholders('Style: {{inputs.style | default: "classic"}}', {
      config: {},
    });
    expect(out).toBe("Style: classic");
  });

  it("applies defaults even when no prepareResult is provided", () => {
    // Authors writing standalone prompts shouldn't need a prepareResult at
    // all to get fallback values rendered.
    const out = interpolatePromptPlaceholders(
      "Style: {{inputs.style | default: 'classic'}}",
      undefined,
    );
    expect(out).toBe("Style: classic");
  });

  it("uses default when the path resolves to null", () => {
    const out = interpolatePromptPlaceholders("Style: {{inputs.style | default: 'classic'}}", {
      config: { style: null },
    });
    expect(out).toBe("Style: classic");
  });

  it("uses default when the path resolves to an empty string", () => {
    // Liquid convention: forms that submit "" for unfilled fields still get
    // the fallback. Without this, `default:` would be useless for its primary
    // use case.
    const out = interpolatePromptPlaceholders("Style: {{inputs.style | default: 'classic'}}", {
      config: { style: "" },
    });
    expect(out).toBe("Style: classic");
  });

  it("does NOT treat 0 or false as missing for default", () => {
    // 0/false are legitimate values; only nil/empty-string trigger fallback.
    const out = interpolatePromptPlaceholders(
      "i={{inputs.i | default: '99'}} ok={{inputs.ok | default: 'yes'}}",
      { config: { i: 0, ok: false } },
    );
    expect(out).toBe("i=0 ok=false");
  });

  it("supports apostrophes inside double-quoted default literals", () => {
    // Authors reach for the double-quoted form precisely when the fallback
    // contains an apostrophe ("don't", "it's"). Single-quoted literals don't
    // support backslash escapes, so this is the documented way to embed `'`.
    const out = interpolatePromptPlaceholders(`Reply: {{inputs.greeting | default: "it's me"}}`, {
      config: {},
    });
    expect(out).toBe("Reply: it's me");
  });

  it("renders an empty string when default is `''` and the path is missing", () => {
    // Edge of the falsy-handling rule: an explicit empty fallback should
    // still apply, producing an empty substitution rather than leaving the
    // placeholder verbatim. Pin it so the `?? cursor` fallthrough doesn't
    // accidentally start treating `""` defaults as absent.
    const out = interpolatePromptPlaceholders("[{{inputs.x | default: ''}}]", { config: {} });
    expect(out).toBe("[]");
  });
});
