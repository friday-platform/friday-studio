/**
 * Eval C — Chat renders the transient state correctly.
 *
 * The chip template in `chat-message-list.svelte` branches on
 * `integration.kind === "credential_temporarily_unavailable"`:
 *   - transient → "try again in a moment" copy + dedicated testid
 *   - dead → "reconnect" copy
 *
 * The user-visible contract is this branch and its copy. Rendering
 * `chat-message-list.svelte` in isolation is heavy (it drags in
 * tool-burst, tool-call-card, table helpers, etc.), so this eval pins
 * the contract at the source-file level — the conditional, the
 * transient-branch copy, the testid format, and the absence of any
 * retry-button affordance.
 *
 * Drift in any of these strings means the eval fails loudly before a
 * user sees the wrong banner.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CHIP_FILE = resolve(
  here,
  "../../agent-playground/src/lib/components/chat/chat-message-list.svelte",
);

const source = readFileSync(CHIP_FILE, "utf8");

describe("oauth-refresh eval C — transient chip rendering", () => {
  it("branches on the credential_temporarily_unavailable kind", () => {
    expect(source).toMatch(/integration\.kind === ["']credential_temporarily_unavailable["']/);
  });

  it("renders the transient copy in the transient branch", () => {
    expect(source).toMatch(/Friday couldn't reach/);
    expect(source).toMatch(/try again in a moment/);
  });

  it("renders the dead-credential copy in the else branch", () => {
    // Pre-existing main-branch copy — eval pins it so a future refactor
    // can't silently collapse the two branches.
    expect(source).toMatch(/is disconnected — reconnect/);
  });

  it("emits a kind-specific data-testid so QA can target either chip", () => {
    expect(source).toMatch(/data-testid=\{`integration-chip-\$\{integration\.kind\}`\}/);
  });

  it("does NOT offer a Retry button on the transient chip", () => {
    // The minimum scope was 'surface to chat', not 'let user retry in
    // chat'. If a Retry button creeps back, this eval flags it.
    const transientBranch = extractTransientBranch(source);
    expect(transientBranch).not.toMatch(/Retry/i);
    expect(transientBranch).not.toMatch(/<button/i);
  });

  it("dedupes chips per (serverId, kind) across messages in the same list", () => {
    // Two agents in one turn (workspace-chat parent + delegated sub-agent)
    // can each attach the same disconnect entry. The list-level dedup
    // keeps the chip from rendering twice.
    expect(source).toMatch(/disconnectIntegrationsByMessageId/);
    expect(source).toMatch(/\$\{i\.serverId\}::\$\{i\.kind\}/);
  });

  it("renders the chip with role='status' (non-interactive, screen-reader friendly)", () => {
    expect(source).toMatch(/role="status"/);
  });
});

/**
 * Slice out the `{#if integration.kind === "credential_temporarily_unavailable"}`
 * branch up to its `{:else}` so we can assert only on the transient copy.
 */
function extractTransientBranch(svelteSource: string): string {
  const startMarker = `integration.kind === "credential_temporarily_unavailable"`;
  const startIdx = svelteSource.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error("transient branch marker not found in source");
  }
  const afterStart = svelteSource.slice(startIdx);
  const elseIdx = afterStart.indexOf("{:else}");
  if (elseIdx === -1) {
    throw new Error("transient branch must be followed by {:else}");
  }
  return afterStart.slice(0, elseIdx);
}
