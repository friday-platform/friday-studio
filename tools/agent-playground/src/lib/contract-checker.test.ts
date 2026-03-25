import { describe, expect, it } from "vitest";
import { compareContracts } from "./contract-checker.ts";

describe("compareContracts", () => {
  it("returns empty comparison for two empty schemas", () => {
    const result = compareContracts({}, {});
    expect(result.fields).toEqual([]);
    expect(result.summary).toEqual({ total: 0, matched: 0, missing: 0, extra: 0, mismatched: 0 });
    expect(result.satisfied).toBe(true);
  });

  it("marks all fields as matched when schemas are identical", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name", "age"],
    };

    const result = compareContracts(schema, schema);
    expect(result.fields).toEqual([
      { field: "name", producerType: "string", consumerType: "string", required: true, status: "match" },
      { field: "age", producerType: "integer", consumerType: "integer", required: true, status: "match" },
    ]);
    expect(result.summary).toEqual({ total: 2, matched: 2, missing: 0, extra: 0, mismatched: 0 });
    expect(result.satisfied).toBe(true);
  });

  it("marks fields missing from producer as 'missing' when consumer requires them", () => {
    const producer = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const consumer = {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["name", "email"],
    };

    const result = compareContracts(producer, consumer);
    expect(result.fields).toContainEqual({
      field: "email",
      producerType: null,
      consumerType: "string",
      required: true,
      status: "missing",
    });
    expect(result.summary.missing).toBe(1);
    expect(result.satisfied).toBe(false);
  });

  it("marks fields in producer but not in consumer as 'extra'", () => {
    const producer = {
      type: "object",
      properties: {
        name: { type: "string" },
        debug: { type: "boolean" },
      },
    };
    const consumer = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const result = compareContracts(producer, consumer);
    expect(result.fields).toContainEqual({
      field: "debug",
      producerType: "boolean",
      consumerType: null,
      required: false,
      status: "extra",
    });
    expect(result.summary.extra).toBe(1);
    expect(result.satisfied).toBe(true);
  });

  it("marks fields with different types as 'type_mismatch'", () => {
    const producer = {
      type: "object",
      properties: { count: { type: "string" } },
      required: ["count"],
    };
    const consumer = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };

    const result = compareContracts(producer, consumer);
    expect(result.fields).toEqual([
      { field: "count", producerType: "string", consumerType: "integer", required: true, status: "type_mismatch" },
    ]);
    expect(result.summary.mismatched).toBe(1);
    expect(result.satisfied).toBe(false);
  });

  it("flattens nested objects with dot-notation", () => {
    const producer = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            path: { type: "string" },
            repo: { type: "string" },
          },
          required: ["path"],
        },
      },
      required: ["data"],
    };
    const consumer = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            path: { type: "string" },
            branch: { type: "string" },
          },
          required: ["path", "branch"],
        },
      },
      required: ["data"],
    };

    const result = compareContracts(producer, consumer);

    expect(result.fields).toContainEqual({
      field: "data.path",
      producerType: "string",
      consumerType: "string",
      required: true,
      status: "match",
    });
    expect(result.fields).toContainEqual({
      field: "data.repo",
      producerType: "string",
      consumerType: null,
      required: false,
      status: "extra",
    });
    expect(result.fields).toContainEqual({
      field: "data.branch",
      producerType: null,
      consumerType: "string",
      required: true,
      status: "missing",
    });
    expect(result.satisfied).toBe(false);
  });

  it("handles array types", () => {
    const producer = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    };
    const consumer = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    };

    const result = compareContracts(producer, consumer);
    expect(result.fields).toEqual([
      { field: "tags", producerType: "string[]", consumerType: "string[]", required: true, status: "match" },
    ]);
  });

  it("detects array item type mismatches", () => {
    const producer = {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
    };
    const consumer = {
      type: "object",
      properties: { ids: { type: "array", items: { type: "integer" } } },
      required: ["ids"],
    };

    const result = compareContracts(producer, consumer);
    expect(result.fields[0]?.status).toBe("type_mismatch");
    expect(result.fields[0]?.producerType).toBe("string[]");
    expect(result.fields[0]?.consumerType).toBe("integer[]");
  });

  it("treats optional consumer fields absent from producer as 'extra' on consumer side (not missing)", () => {
    const producer = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const consumer = {
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
      // nickname is NOT required
    };

    const result = compareContracts(producer, consumer);
    // nickname is in consumer but not producer, and is optional — should NOT be "missing"
    const nicknameField = result.fields.find((f) => f.field === "nickname");
    expect(nicknameField).toEqual({
      field: "nickname",
      producerType: null,
      consumerType: "string",
      required: false,
      status: "extra",
    });
    expect(result.satisfied).toBe(true);
  });

  it("counts summary totals correctly in a mixed scenario", () => {
    const producer = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        count: { type: "string" },
        debug: { type: "boolean" },
      },
    };
    const consumer = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        count: { type: "integer" },
        email: { type: "string" },
      },
      required: ["id", "name", "count", "email"],
    };

    const result = compareContracts(producer, consumer);
    expect(result.summary).toEqual({
      total: 5,
      matched: 2, // id, name
      missing: 1, // email (required by consumer, absent from producer)
      extra: 1, // debug (in producer, not in consumer)
      mismatched: 1, // count (string vs integer)
    });
    expect(result.satisfied).toBe(false);
  });

  it("handles schemas with no properties key", () => {
    const result = compareContracts({ type: "object" }, { type: "object" });
    expect(result.fields).toEqual([]);
    expect(result.satisfied).toBe(true);
  });

  it("handles null-ish schemas gracefully", () => {
    const result = compareContracts(null, null);
    expect(result.fields).toEqual([]);
    expect(result.satisfied).toBe(true);
  });
});
