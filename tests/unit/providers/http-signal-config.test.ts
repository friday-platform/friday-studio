/**
 * Tests for HTTP Signal Configuration Schema
 * Testing the HTTP signal provider functionality
 */

import { assertEquals } from "@std/assert";
import { WorkspaceSignalConfigSchema } from "../../../packages/config/src/signals.ts";

// HTTP Signal Configuration Schema test helper
const HttpSignalConfigSchema = WorkspaceSignalConfigSchema;

Deno.test("HTTP Signal Configuration Schema - Basic validation", async (t) => {
  await t.step("should validate minimal HTTP signal config", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/deploy" },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.provider, "http");
      assertEquals(result.data.config.path, "/webhook/deploy");
    }
  });

  await t.step("should require provider to be valid", () => {
    const config = {
      description: "Test signal",
      provider: "invalid", // Invalid provider
      config: { path: "/webhook/deploy" },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should require config.path field", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: {
        // missing path
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);

    if (!result.success) {
      const pathError = result.error.issues.find((issue) => issue.path.includes("path"));
      assertEquals(!!pathError, true);
    }
  });

  await t.step("should accept empty path", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: {
        path: "", // Empty path is allowed
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);
  });
});

Deno.test("HTTP Signal Configuration Schema - Timeout validation", async (t) => {
  await t.step("should accept timeout duration", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/deploy", timeout: "30s" },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.config.timeout, "30s");
    }
  });

  await t.step("should work without timeout (optional)", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/status" },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.config.timeout, undefined);
    }
  });

  await t.step("should reject invalid timeout format", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: {
        path: "/webhook/deploy",
        timeout: "invalid-timeout", // Should be valid duration
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should reject numeric timeout", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: {
        path: "/webhook/deploy",
        timeout: 30000, // Should be string duration
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });
});

Deno.test("HTTP Signal Configuration Schema - Schema validation", async (t) => {
  await t.step("should accept JSON schema for payload validation", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/deploy" },
      schema: {
        type: "object",
        properties: { environment: { type: "string" }, force: { type: "boolean" } },
        required: ["environment"],
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.schema?.type, "object");
      assertEquals(result.data.schema?.properties?.environment?.type, "string");
    }
  });

  await t.step("should work without schema (optional)", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/status" },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.schema, undefined);
    }
  });

  await t.step("should accept complex schema definitions", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/test" },
      schema: {
        type: "object",
        properties: {
          stringField: { type: "string" },
          numberField: { type: "number" },
          booleanField: { type: "boolean" },
        },
        required: ["stringField"],
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);
  });

  await t.step("should reject invalid schema structure", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/test" },
      schema: "invalid-schema", // Should be object
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should reject non-object schema", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/deploy" },
      schema: ["invalid", "array", "schema"], // Should be object
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });
});

Deno.test("HTTP Signal Configuration Schema - Complex configurations", async (t) => {
  await t.step("should validate complete HTTP configuration", () => {
    const config = {
      description: "Complete HTTP deployment signal",
      provider: "http",
      config: { path: "/webhook/deploy", timeout: "30s" },
      schema: {
        type: "object",
        properties: { environment: { type: "string" }, force: { type: "boolean" } },
        required: ["environment"],
      },
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.provider, "http");
      assertEquals(result.data.config.path, "/webhook/deploy");
      assertEquals(result.data.config.timeout, "30s");
      assertEquals(result.data.schema?.type, "object");
      assertEquals(result.data.schema?.required?.length, 1);
    }
  });

  await t.step("should reject extra fields in strict mode", () => {
    const config = {
      description: "Test HTTP signal",
      provider: "http",
      config: { path: "/webhook/deploy" },
      invalidExtraField: "should-not-be-allowed", // Extra field
    };

    const result = HttpSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should validate path naming conventions", () => {
    const validPaths = [
      "/webhook/deploy",
      "/api/v1/build-and-deploy",
      "/hooks/k8s-restart",
      "/trigger/cleanup_old_logs",
      "/status",
    ];

    validPaths.forEach((path) => {
      const config = { description: "Test HTTP signal", provider: "http", config: { path } };

      const result = HttpSignalConfigSchema.safeParse(config);
      assertEquals(result.success, true, `Path '${path}' should be valid`);
    });
  });
});
