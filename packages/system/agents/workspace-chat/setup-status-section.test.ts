import type { SetupRequirement } from "@atlas/core/elicitations";
import { createLogger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClientGet, mockParseResult } = vi.hoisted(() => ({
  mockClientGet: vi.fn(),
  mockParseResult: vi.fn(),
}));

vi.mock("@atlas/client/v2", () => ({
  client: { workspace: { ":workspaceId": { $get: mockClientGet } } },
  parseResult: mockParseResult,
}));

import {
  fetchWorkspaceSetupStatus,
  formatSetupStatusBlock,
  formatVariableSchemaSummary,
} from "./setup-status-section.ts";

const logger = createLogger({ name: "test" });

const VARIABLE_REQ: SetupRequirement = {
  kind: "variable",
  name: "region",
  description: "AWS region to scope queries to",
  schema: { type: "string", enum: ["us-east-1", "us-west-2"] },
};

const CREDENTIAL_REQ: SetupRequirement = {
  kind: "credential",
  provider: "gmail",
  path: "tools.mcp.servers.gmail.env.TOKEN",
  key: "TOKEN",
  reason: "no_default",
};

const STALE_CREDENTIAL_REQ: SetupRequirement = {
  kind: "credential",
  provider: "github",
  path: "tools.mcp.servers.github.env.PAT",
  key: "PAT",
  reason: "stale_id",
};

describe("formatVariableSchemaSummary", () => {
  it("returns just the type when no constraints declared", () => {
    expect(formatVariableSchemaSummary({ type: "string" })).toBe("string");
    expect(formatVariableSchemaSummary({ type: "boolean" })).toBe("boolean");
  });

  it("renders string constraints inline", () => {
    const out = formatVariableSchemaSummary({
      type: "string",
      enum: ["a", "b"],
      pattern: "^[a-z]+$",
      minLength: 2,
      maxLength: 10,
    });
    expect(out).toBe("string, enum: a|b, pattern: ^[a-z]+$, minLength: 2, maxLength: 10");
  });

  it("renders number bounds inline", () => {
    const out = formatVariableSchemaSummary({ type: "integer", minimum: 0, maximum: 100 });
    expect(out).toBe("integer, min: 0, max: 100");
  });
});

describe("formatSetupStatusBlock", () => {
  it("returns empty string when there are no requirements", () => {
    expect(formatSetupStatusBlock([])).toBe("");
  });

  it("matches the design template verbatim — header, bullets, tools clause", () => {
    const out = formatSetupStatusBlock([VARIABLE_REQ, CREDENTIAL_REQ]);

    expect(out).toBe(
      [
        "[WORKSPACE SETUP STATUS]",
        "This workspace currently has unfilled configuration:",
        "- Variable `region`: AWS region to scope queries to. Required: string, enum: us-east-1|us-west-2.",
        "- Credential: gmail (no default credential selected).",
        "",
        "Do not attempt actions that depend on these. Surface the gap conversationally. Tools:",
        "- env_set(key, value) — fill a single variable. Confirmation card renders.",
        "- connect_service(provider) — open OAuth for a single credential.",
        "- request_workspace_setup() — show the full setup form. Use when multiple gaps OR the user prefers a form to a conversation.",
      ].join("\n"),
    );
  });

  it("renders stale credential reason distinctly from no_default", () => {
    const out = formatSetupStatusBlock([STALE_CREDENTIAL_REQ]);
    expect(out).toContain(
      "- Credential: github (previously-linked credential no longer resolves).",
    );
  });

  it("falls back to a placeholder description when variable has none", () => {
    const out = formatSetupStatusBlock([
      { kind: "variable", name: "max_retries", schema: { type: "integer", minimum: 1 } },
    ]);
    expect(out).toContain(
      "- Variable `max_retries`: (no description provided). Required: integer, min: 1.",
    );
  });
});

describe("fetchWorkspaceSetupStatus", () => {
  beforeEach(() => {
    mockClientGet.mockReset();
    mockParseResult.mockReset();
  });

  it("returns shouldInject=true when requires_setup=true AND active_setup_session_id is null", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: {
        requires_setup: true,
        setup_requirements: [VARIABLE_REQ, CREDENTIAL_REQ],
        metadata: { active_setup_session_id: null },
      },
    });

    const result = await fetchWorkspaceSetupStatus("ws_test", logger);

    expect(result.shouldInject).toBe(true);
    expect(result.setupRequirements).toEqual([VARIABLE_REQ, CREDENTIAL_REQ]);
  });

  it("returns shouldInject=true when metadata is omitted entirely (pointer treated as null)", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { requires_setup: true, setup_requirements: [VARIABLE_REQ] },
    });

    const result = await fetchWorkspaceSetupStatus("ws_test", logger);

    expect(result.shouldInject).toBe(true);
  });

  it("returns shouldInject=false during initial setup (active_setup_session_id non-null)", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: {
        requires_setup: true,
        setup_requirements: [VARIABLE_REQ],
        metadata: { active_setup_session_id: "chat_bootstrap_1" },
      },
    });

    const result = await fetchWorkspaceSetupStatus("ws_test", logger);

    expect(result.shouldInject).toBe(false);
  });

  it("returns shouldInject=false when fully configured (requires_setup=false)", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { requires_setup: false, setup_requirements: [], metadata: {} },
    });

    const result = await fetchWorkspaceSetupStatus("ws_test", logger);

    expect(result.shouldInject).toBe(false);
  });

  it("returns shouldInject=false silently on fetch failure (no false accusation)", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "boom" });

    const result = await fetchWorkspaceSetupStatus("ws_test", logger);

    expect(result.shouldInject).toBe(false);
  });

  it("returns shouldInject=false silently on shape mismatch", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { requires_setup: "not-a-bool", setup_requirements: [] },
    });

    const result = await fetchWorkspaceSetupStatus("ws_test", logger);

    expect(result.shouldInject).toBe(false);
  });
});
