/**
 * Tests for CLI Signal Configuration Schema
 * TDD implementation - tests first, then implementation
 * RED PHASE: These tests should fail initially since enhanced CLI config validation doesn't exist yet
 */

import { assertEquals } from "@std/assert";
import { WorkspaceSignalConfigSchema } from "../../../packages/config/src/schemas.ts";
import { z } from "zod/v4";

// Enhanced CLI Signal Configuration Schema (to be implemented)
const CliSignalConfigSchema = WorkspaceSignalConfigSchema.extend({
  provider: z.literal("cli"),
  command: z.string().min(1, "Command cannot be empty"),
  args: z.array(z.string()).optional().default([]),
  flags: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .default({}),
}).strict();

Deno.test("CLI Signal Configuration Schema - Basic validation", async (t) => {
  await t.step("should validate minimal CLI signal config", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.command, "deploy");
      assertEquals(result.data.args, []);
      assertEquals(result.data.flags, {});
    }
  });

  await t.step("should require provider to be 'cli'", () => {
    const config = {
      description: "Test signal",
      provider: "http", // Wrong provider
      command: "deploy",
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should require command field", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      // missing command
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);

    if (!result.success) {
      const commandError = result.error.issues.find((issue) => issue.path.includes("command"));
      assertEquals(!!commandError, true);
    }
  });

  await t.step("should reject empty command", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "", // Empty command
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });
});

Deno.test("CLI Signal Configuration Schema - Args validation", async (t) => {
  await t.step("should accept string array for args", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      args: ["--env", "production", "--region", "us-west-2"],
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.args, [
        "--env",
        "production",
        "--region",
        "us-west-2",
      ]);
    }
  });

  await t.step("should default args to empty array", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "status",
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.args, []);
    }
  });

  await t.step("should reject non-array args", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      args: "invalid-string-args", // Should be array
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should reject non-string elements in args", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      args: ["--env", "production", 123], // Number in args array
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });
});

Deno.test("CLI Signal Configuration Schema - Flags validation", async (t) => {
  await t.step("should accept object for flags", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      flags: {
        verbose: true,
        force: false,
        timeout: 300,
        environment: "production",
      },
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.flags.verbose, true);
      assertEquals(result.data.flags.force, false);
      assertEquals(result.data.flags.timeout, 300);
      assertEquals(result.data.flags.environment, "production");
    }
  });

  await t.step("should default flags to empty object", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "status",
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.flags, {});
    }
  });

  await t.step("should accept string, number, and boolean flag values", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
      flags: {
        stringFlag: "value",
        numberFlag: 42,
        booleanFlag: true,
      },
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);
  });

  await t.step("should reject array or object flag values", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "test",
      flags: {
        invalidFlag: ["array", "not", "allowed"], // Array not allowed
      },
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });

  await t.step("should reject non-object flags", () => {
    const config = {
      description: "Test CLI signal",
      provider: "cli",
      command: "deploy",
      flags: ["invalid", "array", "flags"], // Should be object
    };

    const result = CliSignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });
});

Deno.test(
  "CLI Signal Configuration Schema - Complex configurations",
  async (t) => {
    await t.step("should validate complete CLI configuration", () => {
      const config = {
        description: "Complete CLI deployment signal",
        provider: "cli",
        command: "deploy",
        args: ["--env", "production", "--region", "us-west-2"],
        flags: {
          verbose: true,
          force: false,
          timeout: 300,
          dryRun: false,
          environment: "production",
        },
        timeout_ms: 30000,
        retry_config: {
          max_retries: 3,
          retry_delay_ms: 1000,
        },
        schema: {
          type: "object",
          properties: {
            environment: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["environment"],
        },
      };

      const result = CliSignalConfigSchema.safeParse(config);
      assertEquals(result.success, true);

      if (result.success) {
        assertEquals(result.data.command, "deploy");
        assertEquals(result.data.args.length, 4);
        assertEquals(result.data.flags.verbose, true);
        assertEquals(result.data.timeout_ms, 30000);
        assertEquals(result.data.retry_config?.max_retries, 3);
      }
    });

    await t.step("should reject extra fields in strict mode", () => {
      const config = {
        description: "Test CLI signal",
        provider: "cli",
        command: "deploy",
        invalidExtraField: "should-not-be-allowed", // Extra field
      };

      const result = CliSignalConfigSchema.safeParse(config);
      assertEquals(result.success, false);
    });

    await t.step("should validate command naming conventions", () => {
      const validCommands = [
        "deploy",
        "build-and-deploy",
        "k8s-restart",
        "cleanup_old_logs",
        "status",
      ];

      validCommands.forEach((command) => {
        const config = {
          description: "Test CLI signal",
          provider: "cli",
          command,
        };

        const result = CliSignalConfigSchema.safeParse(config);
        assertEquals(
          result.success,
          true,
          `Command '${command}' should be valid`,
        );
      });
    });
  },
);
