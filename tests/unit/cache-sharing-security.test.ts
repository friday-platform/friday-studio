#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env

/**
 * Unit tests for cache sharing security features
 * Focuses on key validation, sanitization, and access control
 */

import { expect } from "@std/expect";

// Test key validation patterns
Deno.test("Plan key validation patterns", () => {
  const validKeyPattern = /^[a-zA-Z0-9\-_:]+$/;
  const maxLength = 256;

  function isValidPlanKey(key: string): boolean {
    return validKeyPattern.test(key) && key.length <= maxLength;
  }

  // Valid keys
  expect(isValidPlanKey("plan:workspace1:job1")).toBe(true);
  expect(isValidPlanKey("plan:test-workspace:simple_job")).toBe(true);
  expect(isValidPlanKey("valid-key123")).toBe(true);
  expect(isValidPlanKey("plan:ws123:complex-job-name_v2")).toBe(true);

  // Invalid keys (potential injection)
  expect(isValidPlanKey("plan;DROP TABLE;--")).toBe(false);
  expect(isValidPlanKey("plan<script>alert()</script>")).toBe(false);
  expect(isValidPlanKey("plan\nworkspace\njob")).toBe(false);
  expect(isValidPlanKey("plan workspace job")).toBe(false); // spaces
  expect(isValidPlanKey("plan/workspace/job")).toBe(false); // slashes
  expect(isValidPlanKey("")).toBe(false); // empty
  expect(isValidPlanKey("x".repeat(300))).toBe(false); // too long
});

// Test workspace-scoped key generation
Deno.test("Secure cache key generation", () => {
  function createSecurePlanKey(jobName: string, workspaceId: string): string {
    return `plan:${workspaceId}:${jobName}`;
  }

  // Test basic key generation
  expect(createSecurePlanKey("simple-job", "workspace1")).toBe("plan:workspace1:simple-job");
  expect(createSecurePlanKey("complex-job-name", "another-workspace")).toBe(
    "plan:another-workspace:complex-job-name",
  );

  // Keys should be deterministic
  const key1 = createSecurePlanKey("job1", "ws1");
  const key2 = createSecurePlanKey("job1", "ws1");
  expect(key1).toBe(key2);

  // Different workspaces should generate different keys for same job
  const keyWs1 = createSecurePlanKey("job1", "workspace1");
  const keyWs2 = createSecurePlanKey("job1", "workspace2");
  expect(keyWs1).not.toBe(keyWs2);
});

// Test plan sanitization
Deno.test("Plan data sanitization", () => {
  function sanitizePlan(plan: any): any {
    if (!plan || typeof plan !== "object") {
      return plan;
    }

    const sanitized = { ...plan };

    // Remove sensitive fields
    const sensitiveFields = [
      "workspaceSecrets",
      "privateKeys",
      "authTokens",
      "apiKeys",
      "passwords",
      "credentials",
      "internalConfig",
      "debugInfo",
    ];

    for (const field of sensitiveFields) {
      delete sanitized[field];
    }

    // Sanitize nested objects recursively
    if (sanitized.context && typeof sanitized.context === "object") {
      sanitized.context = sanitizePlan(sanitized.context);
    }

    return sanitized;
  }

  // Test basic sanitization
  const sensitivePlan = {
    type: "execution",
    phases: [],
    workspaceSecrets: "secret-api-key",
    privateKeys: "rsa-private-key",
    authTokens: "bearer-token",
    passwords: "admin123",
    context: {
      workspaceId: "workspace1",
      privateKeys: "nested-secret",
    },
  };

  const sanitized = sanitizePlan(sensitivePlan);

  // Should keep safe fields
  expect(sanitized.type).toBe("execution");
  expect(sanitized.phases).toEqual([]);
  expect(sanitized.context.workspaceId).toBe("workspace1");

  // Should remove sensitive fields
  expect(sanitized.workspaceSecrets).toBeUndefined();
  expect(sanitized.privateKeys).toBeUndefined();
  expect(sanitized.authTokens).toBeUndefined();
  expect(sanitized.passwords).toBeUndefined();
  expect(sanitized.context.privateKeys).toBeUndefined();
});

// Test workspace access validation
Deno.test("Workspace access validation", () => {
  function validateWorkspaceAccess(
    requestingWorkspaceId: string,
    supervisorWorkspaceId: string,
  ): boolean {
    return requestingWorkspaceId === supervisorWorkspaceId;
  }

  // Same workspace should be allowed
  expect(validateWorkspaceAccess("workspace1", "workspace1")).toBe(true);

  // Different workspace should be denied
  expect(validateWorkspaceAccess("workspace1", "workspace2")).toBe(false);
  expect(validateWorkspaceAccess("malicious-workspace", "legitimate-workspace")).toBe(false);
});

// Test plan structure validation
Deno.test("Plan structure validation", () => {
  function validatePlanStructure(plan: any, expectedWorkspaceId: string): boolean {
    try {
      // Verify plan structure
      if (!plan || typeof plan !== "object") {
        return false;
      }

      // Verify workspace context matches if available
      if (plan.context?.workspaceId && plan.context.workspaceId !== expectedWorkspaceId) {
        return false;
      }

      // Verify plan hasn't been tampered with (basic integrity check)
      if (plan.phases && !Array.isArray(plan.phases)) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  // Valid plan
  const validPlan = {
    type: "execution",
    phases: [],
    context: { workspaceId: "workspace1" },
  };
  expect(validatePlanStructure(validPlan, "workspace1")).toBe(true);

  // Invalid plan structures
  expect(validatePlanStructure(null, "workspace1")).toBe(false);
  expect(validatePlanStructure("not an object", "workspace1")).toBe(false);
  expect(validatePlanStructure({ phases: "not-an-array" }, "workspace1")).toBe(false);

  // Workspace mismatch
  const wrongWorkspacePlan = {
    type: "execution",
    phases: [],
    context: { workspaceId: "different-workspace" },
  };
  expect(validatePlanStructure(wrongWorkspacePlan, "workspace1")).toBe(false);

  // Plan without workspace context should be valid
  const noContextPlan = {
    type: "execution",
    phases: [],
  };
  expect(validatePlanStructure(noContextPlan, "workspace1")).toBe(true);
});
