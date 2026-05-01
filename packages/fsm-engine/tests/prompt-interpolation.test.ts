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
});
