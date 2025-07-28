/**
 * Unit tests for WorkspaceUpdater class
 */

import { assertAlmostEquals, assertEquals, assertExists } from "@std/assert";
import { WorkspaceUpdater } from "../src/internal/workspace-update/workspace-updater.ts";

// Mock environment variable for the test
Deno.env.set("ANTHROPIC_API_KEY", "test-api-key");

Deno.test({
  name: "WorkspaceUpdater - Should instantiate correctly",
  fn() {
    const updater = new WorkspaceUpdater();
    assertExists(updater);
  },
});

// User-friendly error handling tests
Deno.test({
  name: "WorkspaceUpdater - Handle workspace not found errors",
  fn() {
    const updater = new WorkspaceUpdater();
    const error = new Error("Workspace not found: test-id");
    const friendly = updater.getUserFriendlyError(error);
    assertEquals(
      friendly,
      "The specified workspace could not be found. Please check the workspace identifier.",
    );
  },
});

Deno.test({
  name: "WorkspaceUpdater - Handle validation errors",
  fn() {
    const updater = new WorkspaceUpdater();
    const error = new Error("Workspace validation failed: Invalid signal reference");
    const friendly = updater.getUserFriendlyError(error);
    assertEquals(
      friendly,
      "The workspace update had validation issues. Please try with different modifications.",
    );
  },
});

Deno.test({
  name: "WorkspaceUpdater - Handle tool errors",
  fn() {
    const updater = new WorkspaceUpdater();
    const error = new Error("There was an issue with workspace tool");
    const friendly = updater.getUserFriendlyError(error);
    assertEquals(friendly, "There was an issue with workspace modification. Please try again.");
  },
});

Deno.test({
  name: "WorkspaceUpdater - Pass through other errors",
  fn() {
    const updater = new WorkspaceUpdater();
    const error = new Error("Custom error message");
    const friendly = updater.getUserFriendlyError(error);
    assertEquals(friendly, "Custom error message");
  },
});

Deno.test({
  name: "WorkspaceUpdater - Handle non-Error objects",
  fn() {
    const updater = new WorkspaceUpdater();
    const friendly = updater.getUserFriendlyError("string error");
    assertEquals(friendly, "string error");
  },
});

// Private method tests
Deno.test({
  name: "WorkspaceUpdater - Calculate temperature correctly for attempts",
  fn() {
    const updater = new WorkspaceUpdater();
    const temp1 = (updater as any).getTemperatureForAttempt(1);
    const temp2 = (updater as any).getTemperatureForAttempt(2);
    const temp3 = (updater as any).getTemperatureForAttempt(3);

    assertAlmostEquals(temp1, 0.4, 0.001);
    assertAlmostEquals(temp2, 0.3, 0.001);
    assertAlmostEquals(temp3, 0.2, 0.001);
  },
});

Deno.test({
  name: "WorkspaceUpdater - Build failure message correctly",
  fn() {
    const updater = new WorkspaceUpdater();
    // Set up attempt history
    (updater as any).attemptHistory = [
      { attempt: 1, errors: ["Error 1", "Error 2"] },
      { attempt: 2, error: "Error 3" },
    ];

    const message = (updater as any).buildFailureMessage(2);
    assertEquals(
      message,
      "Failed to update workspace after 2 attempts. Errors encountered:\n1. Error 1\n2. Error 2\n3. Error 3",
    );
  },
});
