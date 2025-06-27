import { expect } from "@std/expect";
import { z } from "zod/v4";
import { ConfigValidationError, formatZodError } from "../src/validation.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("formatZodError - formats validation errors correctly", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
    nested: z.object({
      field: z.string(),
    }),
  });

  try {
    schema.parse({ name: 123, age: "invalid", nested: { field: 456 } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "test.yml");

      expect(formatted).toContain("Configuration validation failed in test.yml");
      expect(formatted).toContain("name:");
      expect(formatted).toContain("Invalid input: expected string, received number");
      expect(formatted).toContain("age:");
      expect(formatted).toContain("Invalid input: expected number, received string");
      expect(formatted).toContain("nested.field:");
      expect(formatted).toContain("Invalid input: expected string, received number");
    } else {
      throw new Error("Expected ZodError");
    }
  }
});

Deno.test("formatZodError - handles root level errors", () => {
  const schema = z.string();

  try {
    schema.parse(123);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "config.yml");

      expect(formatted).toContain("Configuration validation failed in config.yml");
      expect(formatted).toContain("root:");
      expect(formatted).toContain("Invalid input: expected string, received number");
    } else {
      throw new Error("Expected ZodError");
    }
  }
});

Deno.test("formatZodError - includes received values when available", () => {
  const schema = z.object({
    type: z.enum(["a", "b", "c"]),
  });

  try {
    schema.parse({ type: "invalid" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "test.yml");

      expect(formatted).toContain("Invalid option: expected one of");
    } else {
      throw new Error("Expected ZodError");
    }
  }
});

Deno.test("ConfigValidationError - includes all error details", () => {
  const error = new ConfigValidationError(
    "Invalid configuration",
    "test.yml",
    "agents.test-agent",
    { type: "invalid" },
  );

  expect(error.name).toBe("ConfigValidationError");
  expect(error.file).toBe("test.yml");
  expect(error.field).toBe("agents.test-agent");
  expect(error.value).toEqual({ type: "invalid" });
  expect(error.message).toBe("Invalid configuration");
});

Deno.test("ConfigValidationError - works without optional fields", () => {
  const error = new ConfigValidationError(
    "Missing required field",
    "workspace.yml",
  );

  expect(error.name).toBe("ConfigValidationError");
  expect(error.file).toBe("workspace.yml");
  expect(error.field).toBeUndefined();
  expect(error.value).toBeUndefined();
});

Deno.test("formatZodError - handles deeply nested paths", () => {
  const schema = z.object({
    level1: z.object({
      level2: z.object({
        level3: z.object({
          value: z.number(),
        }),
      }),
    }),
  });

  try {
    schema.parse({
      level1: {
        level2: {
          level3: {
            value: "not a number",
          },
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "nested.yml");

      expect(formatted).toContain("level1.level2.level3.value:");
      expect(formatted).toContain("Invalid input: expected number, received string");
    } else {
      throw new Error("Expected ZodError");
    }
  }
});

Deno.test("formatZodError - handles multiple errors", () => {
  const schema = z.object({
    field1: z.string(),
    field2: z.number(),
    field3: z.boolean(),
  });

  try {
    schema.parse({
      field1: 123,
      field2: "not a number",
      field3: "not a boolean",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "multi.yml");
      const lines = formatted.split("\n");

      // Should have header + 3 error lines
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines[0]).toContain("Configuration validation failed in multi.yml");

      // Should format all errors
      const errorContent = formatted.toLowerCase();
      expect(errorContent).toContain("field1");
      expect(errorContent).toContain("field2");
      expect(errorContent).toContain("field3");
    } else {
      throw new Error("Expected ZodError");
    }
  }
});

Deno.test("formatZodError - handles union errors gracefully", () => {
  const schema = z.union([
    z.object({ type: z.literal("a"), value: z.string() }),
    z.object({ type: z.literal("b"), value: z.number() }),
  ]);

  try {
    schema.parse({ type: "c", value: "invalid" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "union.yml");

      // Should contain some indication of invalid union
      expect(formatted).toContain("Configuration validation failed in union.yml");
      expect(formatted.length).toBeGreaterThan(50); // Should have meaningful error content
    } else {
      throw new Error("Expected ZodError");
    }
  }
});

Deno.test("formatZodError - handles custom error messages", () => {
  const schema = z.object({
    email: z.string().email("Please provide a valid email address"),
    age: z.number().min(18, "Must be at least 18 years old"),
  });

  try {
    schema.parse({ email: "not-an-email", age: 16 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "custom.yml");

      expect(formatted).toContain("Please provide a valid email address");
      expect(formatted).toContain("Must be at least 18 years old");
    } else {
      throw new Error("Expected ZodError");
    }
  }
});
