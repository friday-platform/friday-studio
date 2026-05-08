/**
 * Phase 6 — artifact lifecycle metadata schema.
 *
 * Verifies that {@link ArtifactLifecycleSchema} accepts the discriminated
 * shapes documented in the plan and rejects the ones that look close
 * but are missing required fields. Also asserts that {@link ArtifactSchema}
 * round-trips with and without a `lifecycle` field (back-compat for
 * pre-Phase-6 entries).
 */

import { describe, expect, it } from "vitest";
import { ArtifactLifecycleSchema, ArtifactSchema, CreateArtifactSchema } from "./model.ts";

describe("ArtifactLifecycleSchema", () => {
  it("accepts a durable lifecycle", () => {
    const result = ArtifactLifecycleSchema.safeParse({ kind: "durable" });
    expect(result.success).toBe(true);
  });

  it("accepts an ephemeral lifecycle bound to a session", () => {
    const result = ArtifactLifecycleSchema.safeParse({
      kind: "ephemeral",
      boundTo: { scope: "session", sessionId: "ses_123" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an ephemeral lifecycle bound to a job", () => {
    const result = ArtifactLifecycleSchema.safeParse({
      kind: "ephemeral",
      boundTo: { scope: "job", jobName: "auto-triage", workspaceId: "ws_abc" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional expiresAt on ephemeral", () => {
    const result = ArtifactLifecycleSchema.safeParse({
      kind: "ephemeral",
      boundTo: { scope: "session", sessionId: "ses_123" },
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an ephemeral lifecycle without boundTo", () => {
    const result = ArtifactLifecycleSchema.safeParse({ kind: "ephemeral" });
    expect(result.success).toBe(false);
  });

  it("rejects a session-scoped binding without sessionId", () => {
    const result = ArtifactLifecycleSchema.safeParse({
      kind: "ephemeral",
      boundTo: { scope: "session" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a job-scoped binding without workspaceId", () => {
    const result = ArtifactLifecycleSchema.safeParse({
      kind: "ephemeral",
      boundTo: { scope: "job", jobName: "auto-triage" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const result = ArtifactLifecycleSchema.safeParse({ kind: "permanent" });
    expect(result.success).toBe(false);
  });
});

describe("ArtifactSchema with lifecycle", () => {
  const baseArtifact = {
    id: "art_123",
    type: "file" as const,
    revision: 1,
    data: {
      type: "file" as const,
      contentRef: "a".repeat(64),
      size: 42,
      mimeType: "application/json",
    },
    title: "t",
    summary: "s",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("parses an artifact with no lifecycle (back-compat)", () => {
    const result = ArtifactSchema.safeParse(baseArtifact);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lifecycle).toBeUndefined();
  });

  it("parses an artifact with a durable lifecycle", () => {
    const result = ArtifactSchema.safeParse({ ...baseArtifact, lifecycle: { kind: "durable" } });
    expect(result.success).toBe(true);
  });

  it("parses an artifact with an ephemeral lifecycle", () => {
    const result = ArtifactSchema.safeParse({
      ...baseArtifact,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId: "ses_x" } },
    });
    expect(result.success).toBe(true);
  });
});

describe("CreateArtifactSchema with lifecycle", () => {
  const baseInput = {
    data: { type: "file" as const, content: "{}", contentEncoding: "utf-8" as const },
    title: "t",
    summary: "s",
  };

  it("accepts a create input without lifecycle", () => {
    const result = CreateArtifactSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
  });

  it("accepts a create input with an ephemeral lifecycle", () => {
    const result = CreateArtifactSchema.safeParse({
      ...baseInput,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId: "ses_x" } },
    });
    expect(result.success).toBe(true);
  });
});
