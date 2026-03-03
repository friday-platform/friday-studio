import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createApp } from "./index.ts";
import { SQLiteAdapter } from "./sqlite-adapter.ts";
import type { ResourceMetadata } from "./types.ts";
import {
  MutateResultSchema,
  PublishResultSchema,
  QueryResultSchema,
  ResourceMetadataSchema,
  ResourceVersionSchema,
  ResourceWithDataSchema,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tempDir: string;
let db: Database;
let adapter: SQLiteAdapter;
let app: ReturnType<typeof createApp>;

const WORKSPACE = "ws-test-1";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ledger-routes-test-"));
  db = new Database(join(tempDir, "test.db"));
  adapter = new SQLiteAdapter(db);
  await adapter.init();
  app = createApp(() => adapter);
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // Already closed
  }
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse response JSON through a Zod schema, replacing `as` casts. */
async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const json: unknown = await res.json();
  return schema.parse(json);
}

const ErrorBodySchema = z.object({ error: z.string() });
const DeletedBodySchema = z.object({ deleted: z.boolean() });
const ResetBodySchema = z.object({ reset: z.boolean() });
const DataRecordSchema = z.record(z.string(), z.unknown());

/** @description Provisions a document resource via HTTP and returns the metadata. */
async function provisionDoc(
  slug: string,
  data: unknown = { items: [] },
  schema: unknown = { type: "object" },
): Promise<ResourceMetadata> {
  const res = await app.request(`/v1/resources/${WORKSPACE}/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "user-1",
      slug,
      name: `Test ${slug}`,
      description: `Desc for ${slug}`,
      type: "document",
      schema,
      initialData: data,
    }),
  });
  expect(res.status).toBe(201);
  return parseJson(res, ResourceMetadataSchema);
}

// ---------------------------------------------------------------------------
// GET /v1/skill
// ---------------------------------------------------------------------------

describe("GET /skill", () => {
  test("returns skill text as plain text", async () => {
    const res = await app.request("/v1/skill");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("Resource Data Access");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resources/:workspaceId/provision
// ---------------------------------------------------------------------------

describe("POST /provision", () => {
  test("creates a new resource and returns 201", async () => {
    const meta = await provisionDoc("grocery-list");

    expect(meta.slug).toBe("grocery-list");
    expect(meta.workspaceId).toBe(WORKSPACE);
    expect(meta.type).toBe("document");
    expect(meta.currentVersion).toBe(1);
  });

  test("upserts on duplicate slug", async () => {
    const first = await provisionDoc("dup-slug");
    const second = await provisionDoc("dup-slug");

    expect(second.id).toBe(first.id);
  });

  test("rejects invalid body with 400", async () => {
    const res = await app.request(`/v1/resources/${WORKSPACE}/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "missing-fields" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

describe("onError handler", () => {
  test("returns 422 with enriched error for SQL execution failures", async () => {
    await provisionDoc("err-test");

    // SQL that passes the DML check but fails at execution — triggers a
    // ClientError with SQLite details and schema context for agent self-correction.
    const res = await app.request(`/v1/resources/${WORKSPACE}/err-test/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT nonexistent_column FROM draft" }),
    });

    expect(res.status).toBe(422);
    const body = await parseJson(res, ErrorBodySchema);
    expect(body.error).toContain("Query failed");
    expect(body.error).toContain("Resource schema:");
  });

  test("returns ClientError status code for DML rejection (not 500)", async () => {
    await provisionDoc("err-dml");

    // DML statements trigger a ClientError (422), not a generic 500
    const res = await app.request(`/v1/resources/${WORKSPACE}/err-dml/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "INSERT INTO foo VALUES (1)" }),
    });

    expect(res.status).toBe(422);
    const body = await parseJson(res, ErrorBodySchema);
    expect(body.error).toContain("read-only");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resources/:workspaceId/:slug/query
// ---------------------------------------------------------------------------

describe("POST /query", () => {
  test("returns rows from a SELECT on draft data", async () => {
    await provisionDoc("qtest", { items: [{ name: "milk" }, { name: "eggs" }] });

    const res = await app.request(`/v1/resources/${WORKSPACE}/qtest/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: "SELECT json_each.value FROM draft, json_each(draft.data, '$.items')",
      }),
    });

    expect(res.status).toBe(200);
    const body = await parseJson(res, QueryResultSchema);
    expect(body.rowCount).toBe(2);
  });

  test("returns 404 for non-existent resource", async () => {
    const res = await app.request(`/v1/resources/${WORKSPACE}/nope/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(res.status).toBe(404);
    const body = await parseJson(res, ErrorBodySchema);
    expect(body.error).toContain("not found");
  });

  test("returns 422 when querying a non-document resource", async () => {
    // Provision an external_ref resource
    await app.request(`/v1/resources/${WORKSPACE}/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-1",
        slug: "ext-ref",
        name: "External Ref",
        description: "Test",
        type: "external_ref",
        schema: {},
        initialData: { ref: "https://example.com" },
      }),
    });

    const res = await app.request(`/v1/resources/${WORKSPACE}/ext-ref/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM draft" }),
    });
    expect(res.status).toBe(422);
    const body = await parseJson(res, ErrorBodySchema);
    expect(body.error).toContain("document");
  });

  test("rejects sql exceeding 10000 chars with 400", async () => {
    await provisionDoc("qval");

    const longSql = `SELECT ${"x".repeat(10_001)}`;
    const res = await app.request(`/v1/resources/${WORKSPACE}/qval/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: longSql }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects params array exceeding 100 items with 400", async () => {
    await provisionDoc("qval2");

    const params = Array.from({ length: 101 }, (_, i) => i);
    const res = await app.request(`/v1/resources/${WORKSPACE}/qval2/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", params }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing sql field with 400", async () => {
    await provisionDoc("qval3");

    const res = await app.request(`/v1/resources/${WORKSPACE}/qval3/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: [] }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resources/:workspaceId/:slug/mutate
// ---------------------------------------------------------------------------

describe("POST /mutate", () => {
  test("applies mutation and marks draft dirty", async () => {
    await provisionDoc("mtest", { count: 0 });

    const res = await app.request(`/v1/resources/${WORKSPACE}/mtest/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT json_set(draft.data, '$.count', 42) FROM draft" }),
    });

    expect(res.status).toBe(200);
    const body = await parseJson(res, MutateResultSchema);
    expect(body.applied).toBe(true);

    // Verify the draft has the new data
    const getRes = await app.request(`/v1/resources/${WORKSPACE}/mtest`);
    const resource = await parseJson(getRes, ResourceWithDataSchema);
    expect(DataRecordSchema.parse(resource.version.data).count).toBe(42);
    expect(resource.version.dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resources/:workspaceId/:slug/publish
// ---------------------------------------------------------------------------

describe("POST /publish", () => {
  test("publishes dirty draft and returns new version number", async () => {
    await provisionDoc("ptest", { v: 1 });

    // Mutate to make it dirty
    await app.request(`/v1/resources/${WORKSPACE}/ptest/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT json_set(draft.data, '$.v', 2) FROM draft" }),
    });

    const res = await app.request(`/v1/resources/${WORKSPACE}/ptest/publish`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await parseJson(res, PublishResultSchema);
    expect(body.version).toBe(2);
  });

  test("returns null version when draft is clean", async () => {
    await provisionDoc("clean-ptest");

    const res = await app.request(`/v1/resources/${WORKSPACE}/clean-ptest/publish`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await parseJson(res, PublishResultSchema);
    expect(body.version).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/resources/:workspaceId/:slug/version
// ---------------------------------------------------------------------------

describe("PUT /version", () => {
  test("creates a new version bypassing draft", async () => {
    await provisionDoc("vtest");

    const res = await app.request(`/v1/resources/${WORKSPACE}/vtest/version`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { replaced: true } }),
    });

    expect(res.status).toBe(201);
    const body = await parseJson(res, ResourceVersionSchema);
    expect(body.version).toBe(2);
    expect(DataRecordSchema.parse(body.data).replaced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/resources/:workspaceId
// ---------------------------------------------------------------------------

describe("GET /list", () => {
  test("returns all resources for a workspace", async () => {
    await provisionDoc("list-a");
    await provisionDoc("list-b");

    const res = await app.request(`/v1/resources/${WORKSPACE}`);
    expect(res.status).toBe(200);

    const body = await parseJson(res, z.array(ResourceMetadataSchema));
    const slugs = body.map((r) => r.slug);
    expect(slugs).toContain("list-a");
    expect(slugs).toContain("list-b");
  });

  test("returns empty array for unknown workspace", async () => {
    const res = await app.request("/v1/resources/ws-unknown");
    expect(res.status).toBe(200);

    const body = await parseJson(res, z.array(ResourceMetadataSchema));
    expect(body).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/resources/:workspaceId/:slug
// ---------------------------------------------------------------------------

describe("GET /resource", () => {
  test("returns resource with draft data by default", async () => {
    await provisionDoc("gtest", { hello: "world" });

    const res = await app.request(`/v1/resources/${WORKSPACE}/gtest`);
    expect(res.status).toBe(200);

    const body = await parseJson(res, ResourceWithDataSchema);
    expect(body.metadata.slug).toBe("gtest");
    expect(body.version.version).toBeNull(); // draft
  });

  test("returns published version with ?published=true", async () => {
    await provisionDoc("gptest", { initial: true });

    const res = await app.request(`/v1/resources/${WORKSPACE}/gptest?published=true`);
    expect(res.status).toBe(200);

    const body = await parseJson(res, ResourceWithDataSchema);
    expect(body.version.version).toBe(1);
  });

  test("returns 404 for non-existent resource", async () => {
    const res = await app.request(`/v1/resources/${WORKSPACE}/nope`);
    expect(res.status).toBe(404);

    const body = await parseJson(res, ErrorBodySchema);
    expect(body.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/resources/:workspaceId/:slug
// ---------------------------------------------------------------------------

describe("DELETE /resource", () => {
  test("deletes a resource", async () => {
    await provisionDoc("dtest");

    const res = await app.request(`/v1/resources/${WORKSPACE}/dtest`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await parseJson(res, DeletedBodySchema);
    expect(body.deleted).toBe(true);

    // Verify it's gone from listing
    const listRes = await app.request(`/v1/resources/${WORKSPACE}`);
    const list = await parseJson(listRes, z.array(ResourceMetadataSchema));
    expect(list.find((r) => r.slug === "dtest")).toBeUndefined();
  });

  test("returns 404 for non-existent resource", async () => {
    const res = await app.request(`/v1/resources/${WORKSPACE}/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await parseJson(res, ErrorBodySchema);
    expect(body.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resources/:workspaceId/:slug/link-ref
// ---------------------------------------------------------------------------

describe("POST /link-ref", () => {
  test("creates a new version with ref data", async () => {
    // Provision an external_ref resource
    const provRes = await app.request(`/v1/resources/${WORKSPACE}/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-1",
        slug: "lrtest",
        name: "Link Ref Test",
        description: "Test",
        type: "external_ref",
        schema: {},
        initialData: { ref: "old-ref" },
      }),
    });
    expect(provRes.status).toBe(201);

    const res = await app.request(`/v1/resources/${WORKSPACE}/lrtest/link-ref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "new-ref-123" }),
    });

    expect(res.status).toBe(201);
    const body = await parseJson(res, ResourceVersionSchema);
    expect(body.version).toBe(2);
    expect(DataRecordSchema.parse(body.data).ref).toBe("new-ref-123");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resources/:workspaceId/:slug/reset-draft
// ---------------------------------------------------------------------------

describe("POST /reset-draft", () => {
  test("resets dirty draft to published version", async () => {
    await provisionDoc("rdtest", { original: true });

    // Mutate to dirty
    await app.request(`/v1/resources/${WORKSPACE}/rdtest/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT json_set(draft.data, '$.modified', true) FROM draft" }),
    });

    // Verify dirty
    const beforeRes = await app.request(`/v1/resources/${WORKSPACE}/rdtest`);
    const before = await parseJson(beforeRes, ResourceWithDataSchema);
    expect(before.version.dirty).toBe(true);

    // Reset
    const res = await app.request(`/v1/resources/${WORKSPACE}/rdtest/reset-draft`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res, ResetBodySchema);
    expect(body.reset).toBe(true);

    // Verify clean
    const afterRes = await app.request(`/v1/resources/${WORKSPACE}/rdtest`);
    const after = await parseJson(afterRes, ResourceWithDataSchema);
    expect(after.version.dirty).toBe(false);
    expect(DataRecordSchema.parse(after.version.data).original).toBe(true);
  });
});
