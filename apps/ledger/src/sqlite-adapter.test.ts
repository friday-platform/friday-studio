import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@db/sqlite";
import { aroundEach, beforeEach, describe, expect, test } from "vitest";
import { createSQLiteAdapter, SQLiteAdapter } from "./sqlite-adapter.ts";
import { ClientError, type ProvisionInput } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let db: Database;
let adapter: SQLiteAdapter;

aroundEach(async (run) => {
  tempDir = await mkdtemp(join(tmpdir(), "ledger-test-"));
  db = new Database(join(tempDir, "test.db"));
  adapter = new SQLiteAdapter(db);
  await run();
  try {
    db.close();
  } catch {
    // Already closed by destroy()
  }
  await rm(tempDir, { recursive: true, force: true });
});

/** @description Provision a document resource with sensible defaults. */
function provisionDoc(slug: string, data: unknown, opts?: Partial<ProvisionInput>) {
  return adapter.provision(
    "ws1",
    {
      userId: "u1",
      slug,
      name: slug,
      description: `${slug} desc`,
      type: "document",
      schema: {},
      ...opts,
    },
    data,
  );
}

/** @description Provision a ref-type resource with sensible defaults. */
function provisionRef(
  slug: string,
  data: unknown,
  type: "external_ref" | "artifact_ref" = "external_ref",
) {
  return adapter.provision(
    "ws1",
    { userId: "u1", slug, name: slug, description: `${slug} desc`, type, schema: {} },
    data,
  );
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

describe("init", () => {
  test("is idempotent — calling init twice does not throw", async () => {
    await adapter.init();
    await expect(adapter.init()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

describe("destroy", () => {
  test("closes the database connection", async () => {
    await adapter.init();
    await adapter.destroy();

    // Attempting to use the db after close should throw
    expect(() => db.prepare("SELECT 1")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// provision()
// ---------------------------------------------------------------------------

describe("provision", () => {
  test("inserts metadata + draft + version 1 and returns ResourceMetadata", async () => {
    await adapter.init();

    const result = await provisionDoc("tasks", [], {
      name: "Tasks",
      description: "Task list",
      schema: { type: "array" },
    });

    // Returns correct ResourceMetadata shape
    expect(result).toMatchObject({
      workspaceId: "ws1",
      slug: "tasks",
      name: "Tasks",
      description: "Task list",
      type: "document",
      currentVersion: 1,
    });
    expect(result.id).toEqual(expect.any(String));
    expect(result.userId).toBe("u1");
    expect(result.createdAt).toEqual(expect.any(String));
    expect(result.updatedAt).toEqual(expect.any(String));
    // Verify draft row exists (version IS NULL)
    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT * FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(result.id);
    expect(draft).toBeDefined();
    expect(draft?.dirty).toBe(0);
    expect(JSON.parse(String(draft?.data))).toEqual([]);
    expect(JSON.parse(String(draft?.schema))).toEqual({ type: "array" });

    // Verify version 1 row exists
    const v1: Record<string, unknown> | undefined = db
      .prepare("SELECT * FROM resource_versions WHERE resource_id = ? AND version = 1")
      .get(result.id);
    expect(v1).toBeDefined();
    expect(v1?.dirty).toBe(0);
    expect(JSON.parse(String(v1?.data))).toEqual([]);
  });

  test("upsert on duplicate slug updates metadata and draft schema, preserves data", async () => {
    await adapter.init();

    const first = await provisionDoc("tasks", [{ item: "eggs" }], {
      name: "Tasks",
      description: "Task list",
      schema: { type: "array" },
    });

    // Manually set draft data to simulate agent mutations
    db.prepare(
      "UPDATE resource_versions SET data = ? WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "eggs" }, { item: "bread" }]), first.id);

    // Re-provision with updated name/description/schema
    const second = await provisionDoc("tasks", [], {
      name: "Updated Tasks",
      description: "Updated description",
      schema: { type: "array", items: { type: "object" } },
    });

    // Same resource ID
    expect(second.id).toBe(first.id);
    // Updated metadata
    expect(second.name).toBe("Updated Tasks");
    expect(second.description).toBe("Updated description");

    // Draft data preserved (not overwritten by re-provision)
    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT * FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(first.id);
    expect(JSON.parse(String(draft?.data))).toEqual([{ item: "eggs" }, { item: "bread" }]);

    // Draft schema updated
    expect(JSON.parse(String(draft?.schema))).toEqual({ type: "array", items: { type: "object" } });

    // No duplicate version 1
    const versions: Record<string, unknown>[] = db
      .prepare("SELECT * FROM resource_versions WHERE resource_id = ? AND version IS NOT NULL")
      .all(first.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// publish()
// ---------------------------------------------------------------------------

describe("publish", () => {
  test("snapshots dirty draft as new version and clears dirty flag", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

    // Simulate agent mutation: update draft data and set dirty
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "eggs" }]), resource.id);

    const result = await adapter.publish("ws1", "tasks");

    // Returns the new version number
    expect(result).toEqual({ version: 2 });

    // Metadata current_version bumped
    const meta: Record<string, unknown> | undefined = db
      .prepare("SELECT current_version FROM resource_metadata WHERE id = ?")
      .get(resource.id);
    expect(meta?.current_version).toBe(2);

    // New version 2 row exists with correct data
    const v2: Record<string, unknown> | undefined = db
      .prepare("SELECT * FROM resource_versions WHERE resource_id = ? AND version = 2")
      .get(resource.id);
    expect(v2).toBeDefined();
    expect(v2?.dirty).toBe(0);
    expect(JSON.parse(String(v2?.data))).toEqual([{ item: "eggs" }]);

    // Draft dirty flag cleared
    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(resource.id);
    expect(draft?.dirty).toBe(0);
  });

  test("returns null version when draft is not dirty", async () => {
    await adapter.init();

    await provisionDoc("tasks", []);

    // Draft is clean after provision — publish should no-op
    const result = await adapter.publish("ws1", "tasks");
    expect(result).toEqual({ version: null });
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(adapter.publish("ws1", "nonexistent")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("query", () => {
  const grocerySchema = {
    type: "object",
    properties: { item: { type: "string" }, quantity: { type: "integer" } },
  };
  const groceryData = [
    { item: "eggs", quantity: 12 },
    { item: "bread", quantity: 1 },
    { item: "milk", quantity: 2 },
  ];

  describe("grocery_list queries", () => {
    beforeEach(async () => {
      await adapter.init();
      await provisionDoc("grocery_list", groceryData, {
        name: "Grocery List",
        description: "Weekly groceries",
        schema: grocerySchema,
      });
    });

    test("simple SELECT returns all rows from draft data", async () => {
      const result = await adapter.query(
        "ws1",
        "grocery_list",
        `SELECT json_extract(j.value, '$.item') as item,
                json_extract(j.value, '$.quantity') as quantity
         FROM draft, json_each(draft.data) j`,
      );

      expect(result.rowCount).toBe(3);
      expect(result.rows).toEqual(groceryData);
    });

    test("SELECT with WHERE filters rows", async () => {
      const result = await adapter.query(
        "ws1",
        "grocery_list",
        `SELECT json_extract(j.value, '$.item') as item,
                json_extract(j.value, '$.quantity') as quantity
         FROM draft, json_each(draft.data) j
         WHERE json_extract(j.value, '$.quantity') > 1`,
      );

      expect(result.rowCount).toBe(2);
      expect(result.rows).toEqual([
        { item: "eggs", quantity: 12 },
        { item: "milk", quantity: 2 },
      ]);
    });

    test("aggregate query returns computed result", async () => {
      const result = await adapter.query(
        "ws1",
        "grocery_list",
        `SELECT COUNT(*) as total_items,
                SUM(json_extract(j.value, '$.quantity')) as total_quantity
         FROM draft, json_each(draft.data) j`,
      );

      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ total_items: 3, total_quantity: 15 }]);
    });

    test("supports parameterized queries", async () => {
      const result = await adapter.query(
        "ws1",
        "grocery_list",
        `SELECT json_extract(j.value, '$.item') as item
         FROM draft, json_each(draft.data) j
         WHERE json_extract(j.value, '$.item') = ?`,
        ["eggs"],
      );

      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ item: "eggs" }]);
    });

    test("throws on invalid SQL", async () => {
      await expect(adapter.query("ws1", "grocery_list", "INVALID SQL GARBAGE")).rejects.toThrow();
    });
  });

  test("reads from draft row, not published versions", async () => {
    await adapter.init();

    const resource = await provisionDoc("grocery_list", [{ item: "eggs" }]);

    // Mutate draft directly and mark dirty
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "eggs" }, { item: "bread" }]), resource.id);

    // Publish to create version 2 with the mutated data
    await adapter.publish("ws1", "grocery_list");

    // Now mutate draft again (unpublished)
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "eggs" }, { item: "bread" }, { item: "milk" }]), resource.id);

    // Query should see the draft (3 items), not version 2 (2 items)
    const result = await adapter.query(
      "ws1",
      "grocery_list",
      "SELECT json_extract(j.value, '$.item') as item FROM draft, json_each(draft.data) j",
    );

    expect(result.rowCount).toBe(3);
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(adapter.query("ws1", "nonexistent", "SELECT * FROM draft")).rejects.toThrow(
      /not found/i,
    );
  });

  test("rejects query on non-document resource type", async () => {
    await adapter.init();

    await provisionRef("sheet_ref", { provider: "google-sheets", ref: "https://example.com" });

    await expect(adapter.query("ws1", "sheet_ref", "SELECT * FROM draft")).rejects.toThrow(
      /document/i,
    );
  });

  test("scopes query to correct workspace", async () => {
    await adapter.init();

    // Same slug in two workspaces with different data
    await provisionDoc("tasks", [{ task: "ws1 task" }]);

    await adapter.provision(
      "ws2",
      {
        userId: "u1",
        slug: "tasks",
        name: "Tasks",
        description: "Tasks",
        type: "document",
        schema: {},
      },
      [{ task: "ws2 task" }],
    );

    const result = await adapter.query(
      "ws1",
      "tasks",
      "SELECT json_extract(j.value, '$.task') as task FROM draft, json_each(draft.data) j",
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ task: "ws1 task" }]);
  });

  describe("rejects DML statements on query()", () => {
    beforeEach(async () => {
      await adapter.init();
      await provisionDoc("grocery_list", [{ item: "eggs" }], {
        name: "Grocery List",
        description: "Weekly groceries",
        schema: { type: "array" },
      });
    });

    const dmlStatements = [
      { label: "INSERT", sql: "INSERT INTO foo VALUES (1)" },
      { label: "UPDATE", sql: "UPDATE foo SET x = 1" },
      { label: "DELETE", sql: "DELETE FROM foo" },
      { label: "DROP", sql: "DROP TABLE foo" },
      { label: "ALTER", sql: "ALTER TABLE foo ADD COLUMN bar TEXT" },
      { label: "CREATE", sql: "CREATE TABLE foo (id INTEGER)" },
      { label: "REPLACE", sql: "REPLACE INTO foo VALUES (1)" },
    ];

    for (const { label, sql } of dmlStatements) {
      test(`rejects ${label}`, async () => {
        await expect(adapter.query("ws1", "grocery_list", sql)).rejects.toThrow(/read-only/i);
      });

      test(`rejects ${label} with leading whitespace`, async () => {
        await expect(adapter.query("ws1", "grocery_list", `  \t\n${sql}`)).rejects.toThrow(
          /read-only/i,
        );
      });

      test(`rejects ${label.toLowerCase()} (lowercase)`, async () => {
        await expect(adapter.query("ws1", "grocery_list", sql.toLowerCase())).rejects.toThrow(
          /read-only/i,
        );
      });
    }
  });

  test("agent $1 params bind to agent values, not CTE internals", async () => {
    await adapter.init();

    await provisionDoc("items", [
      { item: "eggs", category: "dairy" },
      { item: "bread", category: "bakery" },
      { item: "milk", category: "dairy" },
    ]);

    // Agent SQL uses $1 — before the fix, $1 would collide with the CTE's
    // internal resource_id parameter, causing silent wrong-value binding.
    const result = await adapter.query(
      "ws1",
      "items",
      `SELECT json_extract(j.value, '$.item') as item
       FROM draft, json_each(draft.data) j
       WHERE json_extract(j.value, '$.category') = $1`,
      ["dairy"],
    );

    expect(result.rowCount).toBe(2);
    expect(result.rows.map((r) => r.item).sort()).toEqual(["eggs", "milk"]);
  });

  test("agent $1 params work correctly in mutate", async () => {
    await adapter.init();

    await provisionDoc("items", [
      { item: "eggs", category: "dairy" },
      { item: "bread", category: "bakery" },
    ]);

    // Filter items by category using $1 param
    const result = await adapter.mutate(
      "ws1",
      "items",
      `SELECT json_group_array(j.value)
       FROM draft, json_each(draft.data) j
       WHERE json_extract(j.value, '$.category') = $1`,
      ["dairy"],
    );

    expect(result).toEqual({ applied: true });

    const resource = await adapter.getResource("ws1", "items");
    expect(resource?.version.data).toEqual([{ item: "eggs", category: "dairy" }]);
  });

  test("query with multiple $N params binds all correctly", async () => {
    await adapter.init();

    await provisionDoc("items", [
      { item: "eggs", category: "dairy", price: 3 },
      { item: "bread", category: "bakery", price: 2 },
      { item: "milk", category: "dairy", price: 4 },
      { item: "cheese", category: "dairy", price: 6 },
    ]);

    const result = await adapter.query(
      "ws1",
      "items",
      `SELECT json_extract(j.value, '$.item') as item
       FROM draft, json_each(draft.data) j
       WHERE json_extract(j.value, '$.category') = $1
         AND json_extract(j.value, '$.price') > $2`,
      ["dairy", 3],
    );

    expect(result.rowCount).toBe(2);
    expect(result.rows.map((r) => r.item).sort()).toEqual(["cheese", "milk"]);
  });

  test("handles data containing single quotes via sqlEscape", async () => {
    await adapter.init();

    await provisionDoc("people", [
      { name: "O'Brien", role: "engineer" },
      { name: "D'Angelo", role: "designer" },
      { name: "Smith", role: "engineer" },
    ]);

    // Query should work despite single quotes in the inlined draft data
    const result = await adapter.query(
      "ws1",
      "people",
      `SELECT json_extract(j.value, '$.name') as name
       FROM draft, json_each(draft.data) j
       WHERE json_extract(j.value, '$.role') = $1`,
      ["engineer"],
    );

    expect(result.rowCount).toBe(2);
    expect(result.rows.map((r) => r.name).sort()).toEqual(["O'Brien", "Smith"]);
  });

  test("mutate works on data containing single quotes", async () => {
    await adapter.init();

    await provisionDoc("people", [
      { name: "O'Brien", role: "engineer" },
      { name: "D'Angelo", role: "designer" },
    ]);

    // Mutate should read the data (with single quotes) correctly and produce valid output
    const result = await adapter.mutate(
      "ws1",
      "people",
      `SELECT json_group_array(j.value)
       FROM draft, json_each(draft.data) j
       WHERE json_extract(j.value, '$.role') = $1`,
      ["engineer"],
    );

    expect(result).toEqual({ applied: true });

    const resource = await adapter.getResource("ws1", "people");
    expect(resource?.version.data).toEqual([{ name: "O'Brien", role: "engineer" }]);
  });

  test("enriches SQL errors with schema context", async () => {
    await adapter.init();

    const schema = { type: "object", properties: { item: { type: "string" } } };
    await provisionDoc("items", [{ item: "a" }], { schema });

    const err = await adapter
      .query("ws1", "items", "SELECT nonexistent_column FROM draft")
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(422);
    expect((err as Error).message).toContain("Resource schema:");
    expect((err as Error).message).toContain('"type":"object"');
  });

  test("malformed SQL returns ClientError 422 with SQLite details and schema (QA 19.3)", async () => {
    await adapter.init();

    const schema = { type: "array", items: { type: "object" } };
    await provisionDoc("grocery_list", [{ item: "eggs" }], { schema });

    const err = await adapter
      .query("ws1", "grocery_list", "SELECTT * FROM draft")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(422);
    expect((err as Error).message).toContain("grocery_list");
    expect((err as Error).message).toContain("Resource schema:");
  });
});

// ---------------------------------------------------------------------------
// mutate()
// ---------------------------------------------------------------------------

describe("mutate", () => {
  test("INSERT — appends a row to JSONB array and sets dirty", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

    // Agent SQL: append an item to the array
    const result = await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs', 'quantity', 12)) FROM draft",
    );

    expect(result).toEqual({ applied: true });

    // Verify draft data was updated
    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT data, dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(draft?.dirty).toBe(1);
    expect(JSON.parse(String(draft?.data))).toEqual([{ item: "eggs", quantity: 12 }]);
  });

  test("UPDATE — modifies existing row in JSONB array", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [{ item: "eggs", quantity: 6 }], {
      schema: { type: "array" },
    });

    // Agent SQL: update quantity for eggs
    const result = await adapter.mutate(
      "ws1",
      "tasks",
      `SELECT json_group_array(
        CASE
          WHEN json_extract(j.value, '$.item') = 'eggs'
          THEN json_set(j.value, '$.quantity', 24)
          ELSE j.value
        END
      )
      FROM draft, json_each(draft.data) j`,
    );

    expect(result).toEqual({ applied: true });

    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(resource.id);
    expect(JSON.parse(String(draft?.data))).toEqual([{ item: "eggs", quantity: 24 }]);
  });

  test("DELETE — removes rows from JSONB array via filter", async () => {
    await adapter.init();

    const resource = await provisionDoc(
      "tasks",
      [
        { item: "eggs", quantity: 12 },
        { item: "bread", quantity: 0 },
        { item: "milk", quantity: 2 },
      ],
      { schema: { type: "array" } },
    );

    // Agent SQL: remove items where quantity is 0
    const result = await adapter.mutate(
      "ws1",
      "tasks",
      `SELECT json_group_array(j.value)
       FROM draft, json_each(draft.data) j
       WHERE json_extract(j.value, '$.quantity') > 0`,
    );

    expect(result).toEqual({ applied: true });

    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(resource.id);
    expect(JSON.parse(String(draft?.data))).toEqual([
      { item: "eggs", quantity: 12 },
      { item: "milk", quantity: 2 },
    ]);
  });

  test("multiple mutations accumulate dirty state", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

    // First mutation: add eggs
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs', 'quantity', 12)) FROM draft",
    );

    // Second mutation: add bread
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'bread', 'quantity', 1)) FROM draft",
    );

    // Both accumulated
    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT data, dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(draft?.dirty).toBe(1);
    expect(JSON.parse(String(draft?.data))).toEqual([
      { item: "eggs", quantity: 12 },
      { item: "bread", quantity: 1 },
    ]);
  });

  test("supports parameterized queries for prose replacement", async () => {
    await adapter.init();

    await provisionDoc("notes", "", {
      name: "Notes",
      description: "Meeting notes",
      schema: { type: "string", format: "markdown" },
    });

    const result = await adapter.mutate("ws1", "notes", "SELECT ? FROM draft", [
      "# Updated Notes\n\nNew content here",
    ]);

    expect(result).toEqual({ applied: true });

    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT data FROM resource_versions rv JOIN resource_metadata rm ON rv.resource_id = rm.id WHERE rm.slug = 'notes' AND rm.workspace_id = 'ws1' AND rv.version IS NULL",
      )
      .get();
    expect(JSON.parse(String(draft?.data))).toBe("# Updated Notes\n\nNew content here");
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(
      adapter.mutate("ws1", "nonexistent", "SELECT draft.data FROM draft"),
    ).rejects.toThrow(/not found/i);
  });

  test("throws for non-document resource types", async () => {
    await adapter.init();

    await provisionRef("sheet-ref", { provider: "google-sheets", ref: "https://example.com" });

    await expect(
      adapter.mutate("ws1", "sheet-ref", "SELECT draft.data FROM draft"),
    ).rejects.toThrow(/document/i);
  });

  test("throws on invalid SQL", async () => {
    await adapter.init();

    await provisionDoc("tasks", [], { schema: { type: "array" } });

    await expect(adapter.mutate("ws1", "tasks", "THIS IS NOT VALID SQL")).rejects.toThrow();
  });

  test("increments draft_version on each mutation", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

    // draft_version starts at 0
    const before: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(before?.draft_version).toBe(0);

    // First mutation
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs')) FROM draft",
    );

    const after1: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(after1?.draft_version).toBe(1);

    // Second mutation
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'bread')) FROM draft",
    );

    const after2: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(after2?.draft_version).toBe(2);
  });

  test("stale draft_version UPDATE affects zero rows", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

    // Mutate to bump draft_version to 1
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs')) FROM draft",
    );

    // Simulate a stale write: attempt UPDATE with draft_version = 0 (already bumped to 1)
    const changes = db
      .prepare(
        `UPDATE resource_versions SET data = '[]', dirty = 1, draft_version = draft_version + 1
         WHERE resource_id = ? AND version IS NULL AND draft_version = 0`,
      )
      .run(resource.id);

    // Stale version should affect zero rows — the optimistic check rejected it
    expect(changes).toBe(0);

    // Original data should be untouched
    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(resource.id);
    expect(JSON.parse(String(draft?.data))).toEqual([{ item: "eggs" }]);
  });

  test("publish resets draft_version to 0", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

    // Mutate to bump draft_version
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs')) FROM draft",
    );

    const beforePublish: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(beforePublish?.draft_version).toBe(1);

    await adapter.publish("ws1", "tasks");

    const afterPublish: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(afterPublish?.draft_version).toBe(0);
  });

  test("throws after exhausting retry attempts on persistent conflict", async () => {
    await adapter.init();

    await provisionDoc("tasks", [], { schema: { type: "array" } });

    // Install a trigger that silently drops CAS updates on the draft row,
    // simulating a permanent concurrent modification conflict.
    db.exec(`CREATE TRIGGER trg_force_conflict
      BEFORE UPDATE OF data ON resource_versions
      FOR EACH ROW WHEN OLD.version IS NULL AND NEW.dirty = 1
      BEGIN
        SELECT RAISE(IGNORE);
      END`);

    await expect(
      adapter.mutate(
        "ws1",
        "tasks",
        "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs')) FROM draft",
      ),
    ).rejects.toThrow(/exhausted 3 retries/);

    // Clean up trigger
    db.exec("DROP TRIGGER trg_force_conflict");
  });

  test("resetDraft resets draft_version to 0", async () => {
    await adapter.init();

    const resource = await provisionDoc("tasks", [{ item: "original" }]);

    // Mutate to bump draft_version
    await adapter.mutate(
      "ws1",
      "tasks",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'extra')) FROM draft",
    );

    await adapter.resetDraft("ws1", "tasks");

    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(resource.id);
    expect(draft?.draft_version).toBe(0);
  });

  test("writable CTE returns ClientError 422 with descriptive message (QA 2.2)", async () => {
    await adapter.init();

    const schema = { type: "array" };
    await provisionDoc("tasks", [{ item: "eggs" }], { schema });

    const err = await adapter
      .mutate(
        "ws1",
        "tasks",
        "WITH x AS (DELETE FROM resource_versions RETURNING *) SELECT json_array() FROM draft",
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(422);
    expect((err as Error).message).toContain("resource_versions");
    expect((err as Error).message).toContain("not allowed");
  });
});

// ---------------------------------------------------------------------------
// listResources()
// ---------------------------------------------------------------------------

describe("listResources", () => {
  test("returns all non-deleted resources for a workspace", async () => {
    await adapter.init();

    await provisionDoc("tasks", []);
    await provisionDoc("notes", []);

    const resources = await adapter.listResources("ws1");
    expect(resources).toHaveLength(2);
    expect(resources.map((r) => r.slug).sort()).toEqual(["notes", "tasks"]);
  });

  test("excludes deleted resources", async () => {
    await adapter.init();

    await provisionDoc("tasks", []);
    await provisionDoc("notes", []);

    await adapter.deleteResource("ws1", "tasks");

    const resources = await adapter.listResources("ws1");
    expect(resources).toHaveLength(1);
    expect(resources[0]?.slug).toBe("notes");
  });

  test("returns empty array when workspace has no resources", async () => {
    await adapter.init();

    const resources = await adapter.listResources("ws-empty");
    expect(resources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getResource()
// ---------------------------------------------------------------------------

describe("getResource", () => {
  test("returns draft version by default", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

    const result = await adapter.getResource("ws1", "tasks");
    expect(result).not.toBeNull();
    expect(result?.metadata.id).toBe(meta.id);
    expect(result?.metadata.slug).toBe("tasks");
    expect(result?.version.version).toBeNull();
    expect(result?.version.resourceId).toBe(meta.id);
  });

  test("returns latest published version when published: true", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", [{ item: "eggs" }]);

    // Dirty and publish to create version 2
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "eggs" }, { item: "bread" }]), meta.id);
    await adapter.publish("ws1", "tasks");

    const result = await adapter.getResource("ws1", "tasks", { published: true });
    expect(result).not.toBeNull();
    expect(result?.version.version).toBe(2);
  });

  test("returns null for nonexistent resource", async () => {
    await adapter.init();

    const result = await adapter.getResource("ws1", "nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for deleted resource", async () => {
    await adapter.init();

    await provisionDoc("tasks", []);
    await adapter.deleteResource("ws1", "tasks");

    const result = await adapter.getResource("ws1", "tasks");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteResource()
// ---------------------------------------------------------------------------

describe("deleteResource", () => {
  test("deletes resource and its versions", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", []);

    await adapter.deleteResource("ws1", "tasks");

    // Metadata row should be gone
    const row: Record<string, unknown> | undefined = db
      .prepare("SELECT id FROM resource_metadata WHERE workspace_id = ? AND slug = ?")
      .get("ws1", "tasks");
    expect(row).toBeUndefined();

    // Version rows should be gone (FK CASCADE)
    const versions: Record<string, unknown>[] = db
      .prepare("SELECT id FROM resource_versions WHERE resource_id = ?")
      .all(meta.id);
    expect(versions).toHaveLength(0);
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(adapter.deleteResource("ws1", "nonexistent")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resetDraft()
// ---------------------------------------------------------------------------

describe("resetDraft", () => {
  test("reverts draft data to latest published version and clears dirty", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", [{ item: "eggs" }]);

    // Dirty the draft
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "MUTATED" }]), meta.id);

    await adapter.resetDraft("ws1", "tasks");

    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT data, dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(meta.id);
    expect(draft?.dirty).toBe(0);
    expect(JSON.parse(String(draft?.data))).toEqual([{ item: "eggs" }]);
  });

  test("reverts to latest published version after multiple publishes", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", [{ item: "v1" }]);

    // Publish version 2
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "v2" }]), meta.id);
    await adapter.publish("ws1", "tasks");

    // Dirty draft again
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "dirty" }]), meta.id);

    await adapter.resetDraft("ws1", "tasks");

    const draft: Record<string, unknown> | undefined = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(meta.id);
    expect(JSON.parse(String(draft?.data))).toEqual([{ item: "v2" }]);
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(adapter.resetDraft("ws1", "nonexistent")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// replaceVersion()
// ---------------------------------------------------------------------------

describe("replaceVersion", () => {
  test("creates new version with given data and resets draft to match", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", []);

    const replacement = [{ item: "imported" }];
    const version = await adapter.replaceVersion("ws1", "tasks", replacement);

    expect(version.version).toBe(2);
    expect(version.resourceId).toBe(meta.id);

    // New version row in DB
    const v2: Record<string, unknown> | undefined = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version = 2")
      .get(meta.id);
    expect(JSON.parse(String(v2?.data))).toEqual(replacement);

    // Draft reset to match
    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT data, dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(meta.id);
    expect(JSON.parse(String(draft?.data))).toEqual(replacement);
    expect(draft?.dirty).toBe(0);

    // Metadata current_version bumped
    const updatedMeta: Record<string, unknown> | undefined = db
      .prepare("SELECT current_version FROM resource_metadata WHERE id = ?")
      .get(meta.id);
    expect(updatedMeta?.current_version).toBe(2);
  });

  test("accepts optional schema override", async () => {
    await adapter.init();

    const meta = await provisionDoc("tasks", [], { schema: { type: "array" } });

    const newSchema = { type: "array", items: { type: "string" } };
    const version = await adapter.replaceVersion("ws1", "tasks", ["hello"], newSchema);

    const row: Record<string, unknown> | undefined = db
      .prepare("SELECT schema FROM resource_versions WHERE resource_id = ? AND version = ?")
      .get(meta.id, version.version);
    expect(JSON.parse(String(row?.schema))).toEqual(newSchema);
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(adapter.replaceVersion("ws1", "nonexistent", [])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// linkRef()
// ---------------------------------------------------------------------------

describe("linkRef", () => {
  test("creates new version with ref data", async () => {
    await adapter.init();

    const meta = await provisionRef("report", { ref: null });

    const version = await adapter.linkRef("ws1", "report", "artifact://abc123");

    expect(version.version).toBe(2);
    expect(version.resourceId).toBe(meta.id);

    const row: Record<string, unknown> | undefined = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version = 2")
      .get(meta.id);
    expect(JSON.parse(String(row?.data))).toEqual({ ref: "artifact://abc123" });
  });

  test("bumps metadata current_version and resets draft", async () => {
    await adapter.init();

    const meta = await provisionRef("report", { ref: null });

    await adapter.linkRef("ws1", "report", "artifact://abc123");

    const updatedMeta: Record<string, unknown> | undefined = db
      .prepare("SELECT current_version FROM resource_metadata WHERE id = ?")
      .get(meta.id);
    expect(updatedMeta?.current_version).toBe(2);

    const draft: Record<string, unknown> | undefined = db
      .prepare(
        "SELECT data, dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(meta.id);
    expect(JSON.parse(String(draft?.data))).toEqual({ ref: "artifact://abc123" });
    expect(draft?.dirty).toBe(0);
  });

  test("throws for document resource type", async () => {
    await adapter.init();

    await provisionDoc("grocery-list", { items: [] });

    await expect(adapter.linkRef("ws1", "grocery-list", "https://example.com")).rejects.toThrow(
      /external_ref/i,
    );
  });

  test("throws when resource does not exist", async () => {
    await adapter.init();

    await expect(adapter.linkRef("ws1", "nonexistent", "ref://foo")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// publishAllDirty()
// ---------------------------------------------------------------------------

describe("publishAllDirty", () => {
  test("publishes only dirty drafts and returns metadata", async () => {
    await adapter.init();

    const metaA = await provisionDoc("tasks", [{ item: "eggs" }]);
    const metaB = await provisionDoc("notes", ["first note"]);
    await provisionDoc("clean", []);

    // Dirty tasks and notes, leave clean untouched
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify([{ item: "bread" }]), metaA.id);
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify(["second note"]), metaB.id);

    const published = await adapter.publishAllDirty("ws1");

    expect(published).toHaveLength(2);
    expect(published.map((p) => p.slug).sort()).toEqual(["notes", "tasks"]);

    // Verify version 2 exists for both dirty resources
    const v2Tasks = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version = 2")
      .get(metaA.id) as { data: string } | undefined;
    expect(v2Tasks).toBeDefined();
    expect(JSON.parse(v2Tasks?.data ?? "null")).toEqual([{ item: "bread" }]);

    const v2Notes = db
      .prepare("SELECT data FROM resource_versions WHERE resource_id = ? AND version = 2")
      .get(metaB.id) as { data: string } | undefined;
    expect(v2Notes).toBeDefined();
    expect(JSON.parse(v2Notes?.data ?? "null")).toEqual(["second note"]);

    // Verify dirty flags cleared
    const draftA = db
      .prepare(
        "SELECT dirty, draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(metaA.id) as { dirty: number; draft_version: number };
    expect(draftA.dirty).toBe(0);
    expect(draftA.draft_version).toBe(0);
  });

  test("returns empty array when no drafts are dirty", async () => {
    await adapter.init();

    await provisionDoc("tasks", []);

    const published = await adapter.publishAllDirty("ws1");
    expect(published).toHaveLength(0);
  });

  test("scopes to workspace — does not publish dirty drafts in other workspaces", async () => {
    await adapter.init();

    // Provision in ws1 and ws2
    const metaWs1 = await adapter.provision(
      "ws1",
      { userId: "u1", slug: "data", name: "data", description: "d", type: "document", schema: {} },
      [],
    );
    const metaWs2 = await adapter.provision(
      "ws2",
      { userId: "u1", slug: "data", name: "data", description: "d", type: "document", schema: {} },
      [],
    );

    // Dirty both
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify(["ws1-dirty"]), metaWs1.id);
    db.prepare(
      "UPDATE resource_versions SET data = ?, dirty = 1 WHERE resource_id = ? AND version IS NULL",
    ).run(JSON.stringify(["ws2-dirty"]), metaWs2.id);

    // Publish only ws1
    const published = await adapter.publishAllDirty("ws1");
    expect(published).toHaveLength(1);

    // ws2 draft should still be dirty
    const ws2Draft = db
      .prepare("SELECT dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL")
      .get(metaWs2.id) as { dirty: number };
    expect(ws2Draft.dirty).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getSkill
// ---------------------------------------------------------------------------

describe("getSkill", () => {
  test("returns SQLite skill text", async () => {
    await adapter.init();
    const skill = await adapter.getSkill();

    expect(skill).toContain("# Resource Data Access (SQLite)");
    expect(skill).toContain("resource_read");
    expect(skill).toContain("json_extract");
  });
});

// ---------------------------------------------------------------------------
// createSQLiteAdapter factory
// ---------------------------------------------------------------------------

describe("createSQLiteAdapter", () => {
  test("creates parent directory and returns a working adapter", async () => {
    const nestedPath = join(tempDir, "sub", "dir", "ledger.db");
    const factoryAdapter = await createSQLiteAdapter(nestedPath);

    await factoryAdapter.init();

    // Verify tables exist by opening the db directly
    const verifyDb = new Database(nestedPath, { readonly: true });
    const tables: Record<string, unknown>[] = verifyDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    const tableNames = tables.map((r) => String(r.name));
    expect(tableNames).toContain("resource_metadata");
    expect(tableNames).toContain("resource_versions");
    verifyDb.close();

    await factoryAdapter.destroy();
  });

  test("query() uses the read-only connection, not the writable one", async () => {
    const dbPath = join(tempDir, "ro-test.db");
    const factoryAdapter = await createSQLiteAdapter(dbPath);
    await factoryAdapter.init();

    // Provision and query through the factory-created adapter (which has a read-only connection)
    await factoryAdapter.provision(
      "ws1",
      {
        userId: "u1",
        slug: "ro-test",
        name: "RO Test",
        description: "Test read-only path",
        type: "document",
        schema: { type: "array" },
      },
      [{ item: "eggs" }],
    );

    const result = await factoryAdapter.query(
      "ws1",
      "ro-test",
      "SELECT json_extract(j.value, '$.item') as item FROM draft, json_each(draft.data) j",
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ item: "eggs" }]);

    await factoryAdapter.destroy();
  });

  test("mutate() computes on read-only connection but writes to writable", async () => {
    const dbPath = join(tempDir, "ro-mutate-test.db");
    const factoryAdapter = await createSQLiteAdapter(dbPath);
    await factoryAdapter.init();

    await factoryAdapter.provision(
      "ws1",
      {
        userId: "u1",
        slug: "ro-mut",
        name: "RO Mutate Test",
        description: "Test read-only + write path",
        type: "document",
        schema: { type: "array" },
      },
      [],
    );

    // Mutate through factory adapter (computes on readOnlyDb, writes on db)
    const result = await factoryAdapter.mutate(
      "ws1",
      "ro-mut",
      "SELECT json_insert(draft.data, '$[#]', json_object('item', 'bread')) FROM draft",
    );

    expect(result).toEqual({ applied: true });

    // Verify the write persisted
    const queryResult = await factoryAdapter.query(
      "ws1",
      "ro-mut",
      "SELECT json_extract(j.value, '$.item') as item FROM draft, json_each(draft.data) j",
    );
    expect(queryResult.rows).toEqual([{ item: "bread" }]);

    await factoryAdapter.destroy();
  });
});
