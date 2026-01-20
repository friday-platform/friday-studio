import type { Result } from "@atlas/utils";
import { expect } from "vitest";
import type { Artifact } from "../model.ts";

/**
 * Assert that a Result is Ok and narrow the type.
 */
export function assertResultOk<T>(
  result: Result<T, string>,
): asserts result is { ok: true; data: T } {
  if (!result.ok) {
    throw new Error(`Expected Result.ok, got Result.fail with error: ${result.error}`);
  }
}

/**
 * Assert that a Result is Fail and narrow the type.
 */
export function assertResultFail<T>(
  result: Result<T, string>,
): asserts result is { ok: false; error: string } {
  if (result.ok) {
    throw new Error(`Expected Result.fail, got Result.ok`);
  }
}

/**
 * Assert that an artifact matches expected properties.
 */
export function assertArtifactEqual(actual: Artifact, expected: Partial<Artifact>): void {
  if (expected.id !== undefined) {
    expect(actual.id, "artifact.id mismatch").toBe(expected.id);
  }
  if (expected.type !== undefined) {
    expect(actual.type, "artifact.type mismatch").toBe(expected.type);
  }
  if (expected.revision !== undefined) {
    expect(actual.revision, "artifact.revision mismatch").toBe(expected.revision);
  }
  if (expected.title !== undefined) {
    expect(actual.title, "artifact.title mismatch").toBe(expected.title);
  }
  if (expected.summary !== undefined) {
    expect(actual.summary, "artifact.summary mismatch").toBe(expected.summary);
  }
  if (expected.workspaceId !== undefined) {
    expect(actual.workspaceId, "artifact.workspaceId mismatch").toBe(expected.workspaceId);
  }
  if (expected.chatId !== undefined) {
    expect(actual.chatId, "artifact.chatId mismatch").toBe(expected.chatId);
  }
  if (expected.revisionMessage !== undefined) {
    expect(actual.revisionMessage, "artifact.revisionMessage mismatch").toBe(
      expected.revisionMessage,
    );
  }
  // createdAt should always exist
  expect(actual.createdAt, "artifact.createdAt should exist").toBeDefined();
}
