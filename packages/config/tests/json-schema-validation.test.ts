import { jsonSchemaToZod, validateSignalPayload } from "@atlas/config";
import { assertEquals, assertThrows } from "@std/assert";

// Basic Type Tests
Deno.test("JSON Schema Validation - should convert string type", () => {
  const schema = {
    type: "string",
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid string
  assertEquals(zodSchema.safeParse("hello").success, true);

  // Invalid types
  assertEquals(zodSchema.safeParse(123).success, false);
  assertEquals(zodSchema.safeParse(true).success, false);
  assertEquals(zodSchema.safeParse(null).success, false);
});

Deno.test("JSON Schema Validation - should convert number type", () => {
  const schema = {
    type: "number",
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid numbers
  assertEquals(zodSchema.safeParse(123).success, true);
  assertEquals(zodSchema.safeParse(123.45).success, true);
  assertEquals(zodSchema.safeParse(0).success, true);
  assertEquals(zodSchema.safeParse(-123).success, true);

  // Invalid types
  assertEquals(zodSchema.safeParse("123").success, false);
  assertEquals(zodSchema.safeParse(true).success, false);
});

Deno.test("JSON Schema Validation - should convert integer type", () => {
  const schema = {
    type: "integer",
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid integers
  assertEquals(zodSchema.safeParse(123).success, true);
  assertEquals(zodSchema.safeParse(0).success, true);
  assertEquals(zodSchema.safeParse(-123).success, true);

  // Invalid - decimals
  assertEquals(zodSchema.safeParse(123.45).success, false);
  assertEquals(zodSchema.safeParse("123").success, false);
});

Deno.test("JSON Schema Validation - should convert boolean type", () => {
  const schema = {
    type: "boolean",
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid booleans
  assertEquals(zodSchema.safeParse(true).success, true);
  assertEquals(zodSchema.safeParse(false).success, true);

  // Invalid types
  assertEquals(zodSchema.safeParse("true").success, false);
  assertEquals(zodSchema.safeParse(1).success, false);
  assertEquals(zodSchema.safeParse(null).success, false);
});

Deno.test("JSON Schema Validation - should convert null type", () => {
  const schema = {
    type: "null",
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid null
  assertEquals(zodSchema.safeParse(null).success, true);

  // Invalid types
  assertEquals(zodSchema.safeParse(undefined).success, false);
  assertEquals(zodSchema.safeParse("").success, false);
  assertEquals(zodSchema.safeParse(0).success, false);
});

// Array Tests
Deno.test("JSON Schema Validation - should convert array type", () => {
  const schema = {
    type: "array",
    items: {
      type: "string",
    },
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid arrays
  assertEquals(zodSchema.safeParse([]).success, true);
  assertEquals(zodSchema.safeParse(["a", "b", "c"]).success, true);

  // Invalid - mixed types
  assertEquals(zodSchema.safeParse(["a", 1, "c"]).success, false);
  assertEquals(zodSchema.safeParse("not an array").success, false);
});

Deno.test("JSON Schema Validation - should handle array constraints", () => {
  const schema = {
    type: "array",
    items: {
      type: "number",
    },
    minItems: 2,
    maxItems: 5,
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse([1, 2]).success, true);
  assertEquals(zodSchema.safeParse([1, 2, 3, 4, 5]).success, true);

  // Invalid - too few
  assertEquals(zodSchema.safeParse([1]).success, false);

  // Invalid - too many
  assertEquals(zodSchema.safeParse([1, 2, 3, 4, 5, 6]).success, false);
});

Deno.test("JSON Schema Validation - should handle tuple arrays", () => {
  const schema = {
    type: "array",
    items: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
    ],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid tuple
  assertEquals(zodSchema.safeParse(["hello", 123, true]).success, true);

  // Invalid - wrong types
  assertEquals(zodSchema.safeParse([123, "hello", true]).success, false);

  // Invalid - too many items
  assertEquals(zodSchema.safeParse(["hello", 123, true, "extra"]).success, false);
});

// Object Tests
Deno.test("JSON Schema Validation - should convert object type", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid objects
  assertEquals(zodSchema.safeParse({ name: "John" }).success, true);
  assertEquals(zodSchema.safeParse({ name: "John", age: 30 }).success, true);

  // Invalid - missing required
  assertEquals(zodSchema.safeParse({ age: 30 }).success, false);

  // Invalid - wrong type
  assertEquals(zodSchema.safeParse({ name: 123 }).success, false);
});

Deno.test("JSON Schema Validation - should handle additionalProperties", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    additionalProperties: false,
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse({ name: "John" }).success, true);

  // Invalid - additional property
  assertEquals(zodSchema.safeParse({ name: "John", age: 30 }).success, false);
});

Deno.test("JSON Schema Validation - should handle typed additionalProperties", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    additionalProperties: { type: "number" },
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse({ name: "John", age: 30, score: 100 }).success, true);

  // Invalid - wrong type for additional property
  assertEquals(zodSchema.safeParse({ name: "John", invalid: "string" }).success, false);
});

// String Constraints
Deno.test("JSON Schema Validation - should handle string constraints", () => {
  const schema = {
    type: "string",
    minLength: 3,
    maxLength: 10,
    pattern: "^[a-zA-Z]+$",
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse("Hello").success, true);
  assertEquals(zodSchema.safeParse("ABC").success, true);

  // Invalid - too short
  assertEquals(zodSchema.safeParse("Hi").success, false);

  // Invalid - too long
  assertEquals(zodSchema.safeParse("ThisIsTooLong").success, false);

  // Invalid - pattern mismatch
  assertEquals(zodSchema.safeParse("Hello123").success, false);
});

Deno.test("JSON Schema Validation - should handle string enums", () => {
  const schema = {
    type: "string",
    enum: ["red", "green", "blue"],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse("red").success, true);
  assertEquals(zodSchema.safeParse("green").success, true);
  assertEquals(zodSchema.safeParse("blue").success, true);

  // Invalid
  assertEquals(zodSchema.safeParse("yellow").success, false);
  assertEquals(zodSchema.safeParse("RED").success, false);
});

// Number Constraints
Deno.test("JSON Schema Validation - should handle number constraints", () => {
  const schema = {
    type: "number",
    minimum: 0,
    maximum: 100,
    exclusiveMinimum: true,
    exclusiveMaximum: true,
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse(50).success, true);
  assertEquals(zodSchema.safeParse(0.1).success, true);
  assertEquals(zodSchema.safeParse(99.9).success, true);

  // Invalid - boundaries
  assertEquals(zodSchema.safeParse(0).success, false);
  assertEquals(zodSchema.safeParse(100).success, false);
  assertEquals(zodSchema.safeParse(-1).success, false);
  assertEquals(zodSchema.safeParse(101).success, false);
});

// Complex Nested Schemas
Deno.test("JSON Schema Validation - should handle complex nested objects", () => {
  const schema = {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          email: { type: "string", pattern: "^[^@]+@[^@]+$" },
          age: { type: "number", minimum: 0, maximum: 150 },
        },
        required: ["name", "email"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["user"],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid complex object
  const validData = {
    user: {
      name: "John Doe",
      email: "john@example.com",
      age: 30,
    },
    tags: ["important", "verified"],
    metadata: {
      source: "web",
      version: "1.0",
    },
  };

  assertEquals(zodSchema.safeParse(validData).success, true);

  // Invalid - missing required email
  const invalidData = {
    user: {
      name: "John Doe",
      age: 30,
    },
    tags: ["important"],
  };

  assertEquals(zodSchema.safeParse(invalidData).success, false);
});

// Union Types
Deno.test("JSON Schema Validation - should handle oneOf (union types)", () => {
  const schema = {
    oneOf: [
      { type: "string" },
      { type: "number" },
    ],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse("hello").success, true);
  assertEquals(zodSchema.safeParse(123).success, true);

  // Invalid
  assertEquals(zodSchema.safeParse(true).success, false);
  assertEquals(zodSchema.safeParse([]).success, false);
});

Deno.test("JSON Schema Validation - should handle anyOf", () => {
  const schema = {
    anyOf: [
      { type: "string", minLength: 5 },
      { type: "number", minimum: 10 },
    ],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid
  assertEquals(zodSchema.safeParse("hello").success, true);
  assertEquals(zodSchema.safeParse(15).success, true);

  // Invalid - doesn't match any
  assertEquals(zodSchema.safeParse("hi").success, false);
  assertEquals(zodSchema.safeParse(5).success, false);
});

// AllOf Tests
Deno.test("JSON Schema Validation - should handle allOf (intersection types)", () => {
  const schema = {
    allOf: [
      {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      {
        type: "object",
        properties: {
          age: { type: "number" },
        },
        required: ["age"],
      },
    ],
  };

  const zodSchema = jsonSchemaToZod(schema);

  // Valid - has all required properties
  assertEquals(zodSchema.safeParse({ name: "John", age: 30 }).success, true);

  // Invalid - missing required property
  assertEquals(zodSchema.safeParse({ name: "John" }).success, false);
  assertEquals(zodSchema.safeParse({ age: 30 }).success, false);
});

// Real-world Signal Payload Tests
Deno.test("JSON Schema Validation - should validate webhook payload", () => {
  const signal = {
    provider: "http" as const,
    description: "GitHub webhook",
    config: {
      path: "/webhook/github",
    },
    schema: {
      type: "object",
      properties: {
        repository: {
          type: "object",
          properties: {
            name: { type: "string" },
            full_name: { type: "string" },
            private: { type: "boolean" },
          },
          required: ["name", "full_name"],
        },
        ref: { type: "string" },
        commits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              message: { type: "string" },
              author: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string" },
                },
                required: ["name", "email"],
              },
            },
            required: ["id", "message"],
          },
        },
      },
      required: ["repository", "ref"],
    },
  };

  // Valid payload
  const validPayload = {
    repository: {
      name: "atlas",
      full_name: "tempest/atlas",
      private: false,
    },
    ref: "refs/heads/main",
    commits: [
      {
        id: "abc123",
        message: "Fix bug",
        author: {
          name: "John Doe",
          email: "john@example.com",
        },
      },
    ],
  };

  const result = validateSignalPayload(signal, validPayload);
  assertEquals(result.success, true);

  // Invalid - missing required field
  const invalidPayload = {
    repository: {
      name: "atlas",
      // Missing full_name
    },
    ref: "refs/heads/main",
  };

  const invalidResult = validateSignalPayload(signal, invalidPayload);
  assertEquals(invalidResult.success, false);
});

Deno.test("JSON Schema Validation - should validate business logic payload", () => {
  const signal = {
    provider: "http" as const,
    description: "Order processing",
    config: {
      path: "/api/orders",
    },
    schema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          pattern: "^ORD-[0-9]{6}$",
        },
        customer: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: {
              type: "string",
              pattern: "^[^@]+@[^@]+\\.[^@]+$",
            },
            tier: {
              type: "string",
              enum: ["bronze", "silver", "gold", "platinum"],
            },
          },
          required: ["id", "email"],
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              quantity: {
                type: "integer",
                minimum: 1,
              },
              price: {
                type: "number",
                minimum: 0,
              },
            },
            required: ["sku", "quantity", "price"],
          },
          minItems: 1,
        },
        total: {
          type: "number",
          minimum: 0,
        },
        status: {
          type: "string",
          enum: ["pending", "processing", "shipped", "delivered", "cancelled"],
        },
      },
      required: ["orderId", "customer", "items", "total", "status"],
    },
  };

  // Valid complex business payload
  const validPayload = {
    orderId: "ORD-123456",
    customer: {
      id: "CUST-789",
      email: "customer@example.com",
      tier: "gold",
    },
    items: [
      {
        sku: "PROD-001",
        quantity: 2,
        price: 29.99,
      },
      {
        sku: "PROD-002",
        quantity: 1,
        price: 49.99,
      },
    ],
    total: 109.97,
    status: "pending",
  };

  const result = validateSignalPayload(signal, validPayload);
  assertEquals(result.success, true);

  // Invalid - wrong order ID format
  const invalidOrderId = { ...validPayload, orderId: "ORDER-123" };
  assertEquals(validateSignalPayload(signal, invalidOrderId).success, false);

  // Invalid - negative quantity
  const invalidQuantity = {
    ...validPayload,
    items: [{ sku: "PROD-001", quantity: -1, price: 29.99 }],
  };
  assertEquals(validateSignalPayload(signal, invalidQuantity).success, false);
});

// Edge Cases
Deno.test("JSON Schema Validation - should handle empty schema", () => {
  const schema = {};

  const zodSchema = jsonSchemaToZod(schema);

  // Empty schema accepts anything
  assertEquals(zodSchema.safeParse("string").success, true);
  assertEquals(zodSchema.safeParse(123).success, true);
  assertEquals(zodSchema.safeParse(true).success, true);
  assertEquals(zodSchema.safeParse({}).success, true);
  assertEquals(zodSchema.safeParse([]).success, true);
});

Deno.test("JSON Schema Validation - should handle true/false schemas", () => {
  // true schema accepts everything
  const trueSchema = jsonSchemaToZod(true);
  assertEquals(trueSchema.safeParse("anything").success, true);
  assertEquals(trueSchema.safeParse(123).success, true);

  // false schema rejects everything
  const falseSchema = jsonSchemaToZod(false);
  assertEquals(falseSchema.safeParse("anything").success, false);
  assertEquals(falseSchema.safeParse(123).success, false);
});

Deno.test("JSON Schema Validation - should throw for unsupported features", () => {
  // $ref is not supported
  const schemaWithRef = {
    type: "object",
    properties: {
      user: { "$ref": "#/definitions/User" },
    },
  };

  assertThrows(
    () => jsonSchemaToZod(schemaWithRef),
    Error,
    "Unsupported JSON Schema feature: $ref",
  );
});
