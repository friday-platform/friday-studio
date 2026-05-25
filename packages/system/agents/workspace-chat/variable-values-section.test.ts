/**
 * Behavioral tests for `formatVariableValuesBlock` — block 4 of the
 * workspace-chat system prompt carries a current-values snapshot built from
 * the same `resolveVariableState` helper the daemon uses. Tests drive the
 * helper with real env-snapshot records (no mocks) so the (env, default,
 * schema) quadrants the formatter cares about match what `resolveVariableState`
 * actually returns.
 */

import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { formatVariableValuesBlock } from "./variable-values-section.ts";

const config = (over: Record<string, unknown>): WorkspaceConfig =>
  WorkspaceConfigSchema.parse({ version: "1.0", workspace: { name: "x" }, ...over });

describe("formatVariableValuesBlock", () => {
  it("marks env-set valid value as filled=true source=env", () => {
    const out = formatVariableValuesBlock(
      config({
        variables: {
          email_recipient: {
            description: "Address that receives alerts.",
            schema: { type: "string", format: "email" },
          },
        },
      }),
      { EMAIL_RECIPIENT: "alice@example.com" },
    );
    expect(out).toBe(
      '<variable-values>\n<variable name="email_recipient" filled="true" source="env"/>\n</variable-values>',
    );
  });

  it("marks env-set but schema-failing value with no default as filled=false source=unset", () => {
    const out = formatVariableValuesBlock(
      config({ variables: { max_price: { schema: { type: "integer", minimum: 100 } } } }),
      { MAX_PRICE: "5" },
    );
    expect(out).toContain('<variable name="max_price" filled="false" source="unset"/>');
  });

  it("marks env-set but schema-failing value as filled=true source=default when a valid default exists", () => {
    const out = formatVariableValuesBlock(
      config({
        variables: { max_price: { schema: { type: "integer", minimum: 100, default: 200 } } },
      }),
      { MAX_PRICE: "5" },
    );
    expect(out).toContain('<variable name="max_price" filled="true" source="default"/>');
  });

  it("marks env-absent variable with a default as filled=true source=default", () => {
    const out = formatVariableValuesBlock(
      config({ variables: { max_price: { schema: { type: "integer", default: 1400 } } } }),
      {},
    );
    expect(out).toContain('<variable name="max_price" filled="true" source="default"/>');
  });

  it("marks env-absent variable without a default as filled=false source=unset", () => {
    const out = formatVariableValuesBlock(
      config({ variables: { email_recipient: { schema: { type: "string", format: "email" } } } }),
      {},
    );
    expect(out).toContain('<variable name="email_recipient" filled="false" source="unset"/>');
  });

  it("returns null when config.variables is an empty record", () => {
    expect(formatVariableValuesBlock(config({ variables: {} }), {})).toBeNull();
  });

  it("returns null when the workspace has no variables: block at all", () => {
    expect(formatVariableValuesBlock(config({}), {})).toBeNull();
    expect(formatVariableValuesBlock(undefined, {})).toBeNull();
  });

  it("preserves declaration order across calls with equal inputs (deterministic iteration)", () => {
    const variables = {
      c_var: { schema: { type: "string" as const } },
      a_var: { schema: { type: "string" as const } },
      b_var: { schema: { type: "string" as const } },
    };
    const first = formatVariableValuesBlock(config({ variables }), {});
    const second = formatVariableValuesBlock(config({ variables }), {});
    expect(second).toBe(first);
    expect(first).not.toBeNull();
    const cIdx = first?.indexOf("c_var") ?? -1;
    const aIdx = first?.indexOf("a_var") ?? -1;
    const bIdx = first?.indexOf("b_var") ?? -1;
    expect(cIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("emits no description, schema, or value bytes — attributes are name/filled/source only", () => {
    const out = formatVariableValuesBlock(
      config({
        variables: {
          email_recipient: {
            description: "Address that receives alerts.",
            schema: { type: "string", format: "email" },
          },
        },
      }),
      { EMAIL_RECIPIENT: "alice@example.com" },
    );
    expect(out).not.toContain("Address that receives alerts.");
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("format");
    expect(out).not.toContain("description");
  });
});
