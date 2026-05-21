import { describe, expect, it } from "vitest";
import { WorkspaceConfigSchema } from "./workspace.ts";

const minimalWorkspace = {
  version: "1.0" as const,
  workspace: { name: "test", id: "test", description: "test workspace" },
};

describe("WorkspaceConfigSchema variables", () => {
  it("parses unchanged when variables block is absent", () => {
    const parsed = WorkspaceConfigSchema.parse(minimalWorkspace);
    expect(parsed.variables).toBeUndefined();
  });

  it("parses an empty variables block", () => {
    const parsed = WorkspaceConfigSchema.parse({ ...minimalWorkspace, variables: {} });
    expect(parsed.variables).toEqual({});
  });

  it("parses string variable with all supported constraint keywords", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      variables: {
        email_recipient: {
          description: "Where to send the report",
          schema: {
            type: "string",
            format: "email",
            pattern: ".+@.+",
            enum: ["a@b.com", "c@d.com"],
            minLength: 3,
            maxLength: 254,
            default: "a@b.com",
          },
        },
      },
    });
    expect(parsed.variables?.email_recipient?.schema.type).toBe("string");
  });

  it("parses number variable with minimum/maximum/enum/default", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      variables: {
        threshold: {
          schema: { type: "number", minimum: 0, maximum: 1, enum: [0.1, 0.5, 0.9], default: 0.5 },
        },
      },
    });
    expect(parsed.variables?.threshold?.schema.type).toBe("number");
  });

  it("parses integer variable with constraints", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      variables: {
        max_retries: { schema: { type: "integer", minimum: 0, maximum: 10, default: 3 } },
      },
    });
    expect(parsed.variables?.max_retries?.schema.type).toBe("integer");
  });

  it("parses boolean variable", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      variables: { notify_owner: { schema: { type: "boolean", default: true } } },
    });
    expect(parsed.variables?.notify_owner?.schema.type).toBe("boolean");
  });

  it("parses display_name when present and leaves it undefined when absent", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      variables: {
        email_recipient: {
          display_name: "Email Recipient",
          schema: { type: "string", format: "email" },
        },
        max_retries: { schema: { type: "integer", default: 3 } },
      },
    });
    expect(parsed.variables?.email_recipient?.display_name).toBe("Email Recipient");
    expect(parsed.variables?.max_retries?.display_name).toBeUndefined();
  });

  it("rejects an array root type with an error path pointing at the variable", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { recipients: { schema: { type: "array" } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("recipients"))).toBe(true);
    }
  });

  it("rejects an object root type", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { cfg: { schema: { type: "object" } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("cfg"))).toBe(true);
    }
  });

  it("rejects $ref", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { v: { schema: { $ref: "#/defs/x" } } },
    });
    expect(result.success).toBe(false);
  });

  it.each(["oneOf", "anyOf", "allOf"])("rejects %s combinators", (combinator) => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { v: { schema: { type: "string", [combinator]: [{ type: "string" }] } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("v"))).toBe(true);
    }
  });

  it.each(["if", "then", "else"])("rejects %s conditional", (key) => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { v: { schema: { type: "string", [key]: { type: "string" } } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects patternProperties", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: {
        v: { schema: { type: "string", patternProperties: { "^.*$": { type: "string" } } } },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing type", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { v: { schema: { minLength: 1 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown root constraint keyword for string", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      variables: { v: { schema: { type: "string", multipleOf: 2 } } },
    });
    expect(result.success).toBe(false);
  });
});
