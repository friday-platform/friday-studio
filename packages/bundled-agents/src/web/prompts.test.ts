import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { getWebAgentPrompt } from "./prompts.ts";

/**
 * Pins the composed prompt hash. The prompt embeds three skill reference files
 * from `.claude/skills/agent-browser/references/` verbatim, so any edit to
 * those files (or to the prompt scaffolding in `prompts.ts`) changes this
 * hash. Failure is expected on intentional skill-file edits — review the diff,
 * confirm the change is intended, then update EXPECTED_PROMPT_HASH below.
 */
const EXPECTED_PROMPT_HASH = "7b04f51e18e03b9c72c2ba287038106750dc5c2ba2f971d643e3045afce870de";

describe("getWebAgentPrompt", () => {
  test("composed prompt matches pinned hash", () => {
    const prompt = getWebAgentPrompt();
    const actualHash = createHash("sha256").update(prompt).digest("hex");

    expect(
      actualHash,
      [
        "Composed web-agent prompt hash drifted.",
        "This test pins the hash of the prompt produced from prompts.ts + the three",
        "skill-reference files under .claude/skills/agent-browser/references/.",
        "If you intentionally edited a skill file or the prompt scaffolding:",
        "  1. Diff the rendered prompt and confirm the change is intentional.",
        `  2. Update EXPECTED_PROMPT_HASH in prompts.test.ts to: ${actualHash}`,
        "If you did NOT intend to change the prompt, investigate the unexpected",
        "edit to the skill files or prompts.ts before updating the constant.",
      ].join("\n"),
    ).toBe(EXPECTED_PROMPT_HASH);
  });
});
