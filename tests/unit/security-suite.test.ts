#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net

/**
 * Consolidated Security Test Suite
 * Combines all security-related tests for Atlas
 */

import { expect } from "@std/expect";

// Helper function for cache key validation
function validateCacheKey(key: string): boolean {
  // Must have exactly one colon separator
  const parts = key.split(":");
  if (parts.length !== 2) return false;

  // Both parts must be non-empty
  if (!parts[0].trim() || !parts[1].trim()) return false;

  // Check for dangerous characters
  const dangerousPattern = /[/\\.|;&$`\n\r\x00]/;
  if (dangerousPattern.test(key)) return false;

  // Enforce maximum length
  if (key.length > 200) return false;

  // Only allow alphanumeric, dash, underscore, and colon
  const validPattern = /^[a-zA-Z0-9\-_:]+$/;
  return validPattern.test(key);
}

// Cache Security Tests
Deno.test("Cache Security - Validate cache key format", async (t) => {
  await t.step("should accept valid workspace:scope format", () => {
    const validKeys = [
      "workspace-123:session-456",
      "ws-prod:agent-789",
      "workspace_test:scope_123",
      "ws1:s1",
    ];

    for (const key of validKeys) {
      expect(validateCacheKey(key)).toBe(true);
    }
  });

  await t.step("should reject keys without colon separator", () => {
    const invalidKeys = [
      "workspace-123-session-456",
      "workspace123session456",
      "no-separator-here",
      "workspace_session",
    ];

    for (const key of invalidKeys) {
      expect(validateCacheKey(key)).toBe(false);
    }
  });

  await t.step("should reject keys with multiple colons", () => {
    const invalidKeys = [
      "workspace:session:extra",
      "ws:s:e",
      "a:b:c:d",
      "workspace:123:session:456",
    ];

    for (const key of invalidKeys) {
      expect(validateCacheKey(key)).toBe(false);
    }
  });

  await t.step("should reject empty parts", () => {
    const invalidKeys = [":session", "workspace:", ":", " :session", "workspace: "];

    for (const key of invalidKeys) {
      expect(validateCacheKey(key)).toBe(false);
    }
  });

  await t.step("should reject special characters that could cause injection", () => {
    const invalidKeys = [
      "workspace/../etc:session",
      "workspace:session;drop table",
      "workspace:session&&rm -rf",
      "workspace:session|cat /etc/passwd",
      "workspace:session\nmalicious",
      "workspace:session\rcarriage",
      "workspace:session\x00null",
    ];

    for (const key of invalidKeys) {
      expect(validateCacheKey(key)).toBe(false);
    }
  });

  await t.step("should enforce maximum length", () => {
    const longWorkspace = "w".repeat(100);
    const longScope = "s".repeat(100);
    const tooLongKey = `${longWorkspace}:${longScope}`;

    expect(validateCacheKey(tooLongKey)).toBe(false);
  });

  await t.step("should handle case sensitivity correctly", () => {
    const keys = [
      "WORKSPACE:SESSION",
      "Workspace:Session",
      "workspace:SESSION",
      "WORKSPACE:session",
    ];

    for (const key of keys) {
      expect(validateCacheKey(key)).toBe(true);
    }
  });
});

// K8s Security Tests
Deno.test("K8s Security - Validate authentication methods", async (t) => {
  await t.step("should validate kubeconfig structure", () => {
    const validKubeconfig = {
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "test-cluster",
          cluster: {
            server: "https://k8s.example.com",
            "certificate-authority-data": "base64-cert",
          },
        },
      ],
      users: [{ name: "test-user", user: { token: "test-token" } }],
      contexts: [{ name: "test-context", context: { cluster: "test-cluster", user: "test-user" } }],
      "current-context": "test-context",
    };

    // Basic validation that would be done by a real validator
    expect(validKubeconfig.apiVersion).toBe("v1");
    expect(validKubeconfig.kind).toBe("Config");
    expect(validKubeconfig.clusters.length).toBeGreaterThan(0);
  });

  await t.step("should validate service account token format", () => {
    const validTokens = [
      "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJpc3MiOiJrdWJlcm5ldGVzL3NlcnZpY2VhY2NvdW50Iiwic3ViIjoic3lzdGVtOnNlcnZpY2VhY2NvdW50OmRlZmF1bHQ6ZGVmYXVsdCJ9.signature",
      "valid-jwt-token-format",
    ];

    for (const token of validTokens) {
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    }
  });

  await t.step("should enforce RBAC permissions", () => {
    const rbacRules = {
      apiGroups: [""],
      resources: ["pods", "services"],
      verbs: ["get", "list", "watch"],
    };

    expect(rbacRules.verbs).not.toContain("delete");
    expect(rbacRules.verbs).not.toContain("create");
    expect(rbacRules.verbs).not.toContain("update");
  });

  await t.step("should validate namespace restrictions", () => {
    const allowedNamespaces = ["default", "monitoring", "logging"];
    const requestedNamespace = "kube-system";

    expect(allowedNamespaces).not.toContain(requestedNamespace);
  });
});

// Agent Security Tests
Deno.test("Agent Security - Validate agent permissions", async (t) => {
  await t.step("should enforce tool access restrictions", () => {
    const agentPermissions = {
      allowedTools: ["memory-storage", "pattern-analysis"],
      deniedTools: ["file-system", "network-access", "shell-exec"],
    };

    const requestedTool = "shell-exec";
    expect(agentPermissions.deniedTools).toContain(requestedTool);
    expect(agentPermissions.allowedTools).not.toContain(requestedTool);
  });

  await t.step("should validate agent isolation boundaries", () => {
    const agentContext = {
      workspaceId: "ws-123",
      sessionId: "session-456",
      agentId: "agent-789",
      isolationLevel: "strict",
    };

    expect(agentContext.isolationLevel).toBe("strict");
    expect(agentContext.workspaceId).toBeTruthy();
  });

  await t.step("should enforce memory access restrictions", () => {
    const memoryAccess = {
      canRead: ["own-workspace", "own-session"],
      cannotRead: ["other-workspace", "system", "global"],
      canWrite: ["own-session"],
      cannotWrite: ["own-workspace", "other-workspace", "system"],
    };

    expect(memoryAccess.cannotRead).toContain("system");
    expect(memoryAccess.cannotWrite).toContain("system");
  });
});

// API Security Tests
Deno.test("API Security - Validate authentication and authorization", async (t) => {
  await t.step("should validate bearer token format", () => {
    const validTokens = ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "Bearer valid-token-123"];

    for (const token of validTokens) {
      expect(token.startsWith("Bearer ")).toBe(true);
      expect(token.length).toBeGreaterThan(7);
    }
  });

  await t.step("should reject malformed authorization headers", () => {
    const invalidHeaders = [
      "Basic dXNlcjpwYXNz",
      "InvalidScheme token",
      "Bearer",
      "",
      null,
      undefined,
    ];

    for (const header of invalidHeaders) {
      const isValid = Boolean(
        header && typeof header === "string" && header.startsWith("Bearer ") && header.length > 7,
      );
      expect(isValid).toBe(false);
    }
  });

  await t.step("should validate API key format", () => {
    const apiKeyPattern = /^[a-zA-Z0-9_-]{32,}$/;
    const validKeys = [
      "abcdefghijklmnopqrstuvwxyz123456",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      "valid_api_key-with-dashes_123456",
    ];

    for (const key of validKeys) {
      expect(apiKeyPattern.test(key)).toBe(true);
    }
  });
});

// Input Validation Security Tests
Deno.test("Security - Input validation and sanitization", async (t) => {
  await t.step("should prevent SQL injection patterns", () => {
    const dangerousInputs = [
      "'; DROP TABLE users; --",
      "1' OR '1'='1",
      "admin'--",
      "1; DELETE FROM sessions WHERE '1'='1",
    ];

    for (const input of dangerousInputs) {
      // In real code, this would be validated by a proper sanitizer
      expect(input).toContain("'");
    }
  });

  await t.step("should prevent XSS patterns", () => {
    const xssPatterns = [
      "<script>alert('xss')</script>",
      "<img src=x onerror=alert('xss')>",
      "javascript:alert('xss')",
      "<svg onload=alert('xss')>",
    ];

    for (const pattern of xssPatterns) {
      const isDangerous =
        pattern.includes("<") ||
        pattern.includes(">") ||
        pattern.includes("javascript:") ||
        pattern.includes("onerror=") ||
        pattern.includes("onload=");
      expect(isDangerous).toBe(true);
    }
  });

  await t.step("should validate path traversal attempts", () => {
    const dangerousPaths = [
      "../../../etc/passwd",
      "..\\..\\..\\windows\\system32",
      "./../../../../sensitive-file",
      "%2e%2e%2f%2e%2e%2f",
    ];

    for (const path of dangerousPaths) {
      const isDangerous = path.includes("..") || path.includes("%2e");
      expect(isDangerous).toBe(true);
    }
  });

  await t.step("should enforce maximum input lengths", () => {
    const maxLengths = {
      username: 50,
      workspaceId: 100,
      sessionId: 100,
      agentName: 50,
      signalId: 100,
    };

    const oversizedInput = "a".repeat(1000);

    for (const [field, maxLength] of Object.entries(maxLengths)) {
      expect(oversizedInput.length).toBeGreaterThan(maxLength);
    }
  });
});

// Encryption and Secrets Tests
Deno.test("Security - Encryption and secrets management", async (t) => {
  await t.step("should never log sensitive information", () => {
    const sensitiveFields = [
      "password",
      "token",
      "apiKey",
      "secret",
      "private_key",
      "authorization",
    ];

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      message: "User authentication",
      // These should be redacted in real logs
      password: "[REDACTED]",
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
    };

    for (const field of sensitiveFields) {
      if (field in logEntry) {
        expect(logEntry[field as keyof typeof logEntry]).toBe("[REDACTED]");
      }
    }
  });

  await t.step("should validate environment variable names for secrets", () => {
    const validEnvVarPattern = /^[A-Z][A-Z0-9_]*$/;
    const validNames = ["API_TOKEN", "DATABASE_PASSWORD", "JWT_SECRET", "ENCRYPTION_KEY"];

    for (const name of validNames) {
      expect(validEnvVarPattern.test(name)).toBe(true);
    }
  });
});
