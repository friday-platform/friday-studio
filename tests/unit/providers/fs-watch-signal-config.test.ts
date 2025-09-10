/**
 * Tests for FS-WATCH Signal Configuration Schema (TDD - red/green)
 */

import { assertEquals } from "@std/assert";
import { WorkspaceSignalConfigSchema } from "../../../packages/config/src/signals.ts";

// Reuse the discriminated union schema for signals
const SignalConfigSchema = WorkspaceSignalConfigSchema;

Deno.test("FS-WATCH Signal Configuration Schema - Basic validation", async (t) => {
  await t.step("should validate minimal fs-watch config and apply defaults", () => {
    const config = {
      description: "Watch workspace content",
      provider: "fs-watch",
      config: { path: "content/" },
    };

    const result = SignalConfigSchema.safeParse(config);
    assertEquals(result.success, true);

    if (result.success && result.data.provider === "fs-watch") {
      assertEquals(result.data.provider, "fs-watch");
      assertEquals(result.data.config.path, "content/");
      // recursive defaults to true
      assertEquals(result.data.config.recursive, true);
    }
  });

  await t.step("should require config.path field", () => {
    const config = { description: "Missing path", provider: "fs-watch", config: {} };

    const result = SignalConfigSchema.safeParse(config);
    assertEquals(result.success, false);
  });
});

Deno.test("FS-WATCH Signal Configuration Schema - Strict objects", async (t) => {
  await t.step("should reject extra fields due to strict objects", () => {
    const invalidExtra: unknown = {
      description: "Strict object - extra field",
      provider: "fs-watch",
      extra: "nope",
      config: { path: "./", unknown: true },
    };

    const result = SignalConfigSchema.safeParse(invalidExtra);
    assertEquals(result.success, false);
  });
});
