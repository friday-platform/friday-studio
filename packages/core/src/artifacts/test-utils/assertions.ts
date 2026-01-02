import type { Result } from "@atlas/utils";
import { assertEquals, assertExists } from "@std/assert";
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
    assertEquals(actual.id, expected.id, "artifact.id mismatch");
  }
  if (expected.type !== undefined) {
    assertEquals(actual.type, expected.type, "artifact.type mismatch");
  }
  if (expected.revision !== undefined) {
    assertEquals(actual.revision, expected.revision, "artifact.revision mismatch");
  }
  if (expected.title !== undefined) {
    assertEquals(actual.title, expected.title, "artifact.title mismatch");
  }
  if (expected.summary !== undefined) {
    assertEquals(actual.summary, expected.summary, "artifact.summary mismatch");
  }
  if (expected.workspaceId !== undefined) {
    assertEquals(actual.workspaceId, expected.workspaceId, "artifact.workspaceId mismatch");
  }
  if (expected.chatId !== undefined) {
    assertEquals(actual.chatId, expected.chatId, "artifact.chatId mismatch");
  }
  if (expected.revisionMessage !== undefined) {
    assertEquals(
      actual.revisionMessage,
      expected.revisionMessage,
      "artifact.revisionMessage mismatch",
    );
  }
  // createdAt should always exist
  assertExists(actual.createdAt, "artifact.createdAt should exist");
}
