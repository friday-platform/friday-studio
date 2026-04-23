import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { getWebAgentPrompt } from "./prompts.ts";

/**
 * Pins the composed prompt hashes. The prompt embeds three skill reference files
 * from `.claude/skills/agent-browser/references/` verbatim, so any edit to
 * those files (or to the prompt scaffolding in `prompts.ts`) changes these
 * hashes. Failure is expected on intentional skill-file edits — review the diff,
 * confirm the change is intended, then update the hash constants below.
 */
const EXPECTED_HASH_WITH_SEARCH =
  "a0d40a02e29800accab405e22d90451ce82801299f95a09cc8f5b089e4385235";
const EXPECTED_HASH_WITHOUT_SEARCH =
  "eb208a7e24a43cc3412e4285dc2c965fe8e18ee2debe39f37b4ca97911332f92";

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function hashMismatchMessage(actualHash: string): string {
  return [
    "Composed web-agent prompt hash drifted.",
    "This test pins the hash of the prompt produced from prompts.ts + the three",
    "skill-reference files under .claude/skills/agent-browser/references/.",
    "If you intentionally edited a skill file or the prompt scaffolding:",
    "  1. Diff the rendered prompt and confirm the change is intentional.",
    `  2. Update the hash constant in prompts.test.ts to: ${actualHash}`,
    "If you did NOT intend to change the prompt, investigate the unexpected",
    "edit to the skill files or prompts.ts before updating the constant.",
  ].join("\n");
}

describe("getWebAgentPrompt", () => {
  test("prompt with search matches pinned hash", () => {
    const prompt = getWebAgentPrompt({ hasSearch: true });
    const actualHash = hashPrompt(prompt);
    expect(actualHash, hashMismatchMessage(actualHash)).toBe(EXPECTED_HASH_WITH_SEARCH);
  });

  test("prompt without search matches pinned hash", () => {
    const prompt = getWebAgentPrompt({ hasSearch: false });
    const actualHash = hashPrompt(prompt);
    expect(actualHash, hashMismatchMessage(actualHash)).toBe(EXPECTED_HASH_WITHOUT_SEARCH);
  });

  test("prompt without search does not mention search tool", () => {
    const prompt = getWebAgentPrompt({ hasSearch: false });
    expect(prompt).not.toContain("`search`");
  });

  test("prompt with search mentions search tool", () => {
    const prompt = getWebAgentPrompt({ hasSearch: true });
    expect(prompt).toContain("`search`");
  });
});
