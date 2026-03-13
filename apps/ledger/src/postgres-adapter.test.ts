import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PostgresAdapter } from "./postgres-adapter.ts";
import type { ProvisionInput } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20260227000000_create_ledger_tables.sql"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// ENV-gated — skip entirely when no Postgres is available
// ---------------------------------------------------------------------------

const POSTGRES_URL =
  process.env.LEDGER_TEST_POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Try to connect. If it fails, bail out of the entire suite gracefully.
 * This keeps CI green when Postgres is not running.
 */
let sql: Sql;
let canConnect = false;

try {
  sql = postgres(POSTGRES_URL, { max: 5, idle_timeout: 10, connect_timeout: 5, prepare: false });
  await sql`SELECT 1`;
  canConnect = true;
} catch {
  canConnect = false;
}

// deno-lint-ignore no-console
if (!canConnect) console.log("Skipping Postgres adapter tests — no connection available");

describe.skipIf(!canConnect)("PostgresAdapter (Postgres integration)", () => {
  let adapter: PostgresAdapter;

  // -------------------------------------------------------------------------
  // DB prerequisites — idempotent setup for _tempest schema, authenticated role
  // -------------------------------------------------------------------------

  /** Ensures the _tempest helpers and authenticated role exist. */
  async function ensurePrerequisites() {
    // _tempest schema + shortid (simplified version for tests — no pg_hashids dep)
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS _tempest`);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION _tempest.shortid() RETURNS text AS $$
      BEGIN
        RETURN substr(md5(random()::text || clock_timestamp()::text), 1, 12);
      END;
      $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION _tempest.updated_at()
      RETURNS trigger AS $$
      BEGIN
        IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Ensure authenticated role exists (Supabase creates it, but standalone Postgres may not)
    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END $$
    `);

    // Ensure test users exist (FK from resource tables → user)
    for (const id of ["u1", "u2", "user-a", "user-b"]) {
      await sql`
        INSERT INTO public."user" (id, full_name, email)
        VALUES (${id}, ${`Test User ${id}`}, ${`${id}@test.local`})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // Revoke dangerous functions and catalog views from PUBLIC so agent_query
    // can't tamper with RLS context, stall connections, or enumerate schema.
    // Requires supabase_admin (the actual superuser in Supabase). The migration's
    // DO blocks attempt this but fall back gracefully when running as postgres
    // (not superuser). Tests apply it explicitly.
    const adminUrl = POSTGRES_URL.replace("postgres:postgres@", "supabase_admin:postgres@");
    const adminSql = postgres(adminUrl, { max: 1, idle_timeout: 5, prepare: false });
    try {
      await adminSql.unsafe(`
        -- Functions: revoke from PUBLIC, grant back to postgres/service_role
        REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO postgres;
        GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO service_role;

        REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) TO postgres;

        REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) TO postgres;

        REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_until(timestamp with time zone) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep_until(timestamp with time zone) TO postgres;

        REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO postgres;

        REVOKE EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) TO postgres;

        -- Catalog views: revoke from PUBLIC, grant back to postgres
        REVOKE SELECT ON pg_catalog.pg_proc FROM PUBLIC;
        GRANT SELECT ON pg_catalog.pg_proc TO postgres;

        REVOKE SELECT ON pg_catalog.pg_class FROM PUBLIC;
        GRANT SELECT ON pg_catalog.pg_class TO postgres;

        REVOKE SELECT ON pg_catalog.pg_namespace FROM PUBLIC;
        GRANT SELECT ON pg_catalog.pg_namespace TO postgres;

        REVOKE SELECT ON pg_catalog.pg_attribute FROM PUBLIC;
        GRANT SELECT ON pg_catalog.pg_attribute TO postgres;

        REVOKE SELECT ON pg_catalog.pg_roles FROM PUBLIC;
        GRANT SELECT ON pg_catalog.pg_roles TO postgres;

        REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC;
        GRANT SELECT ON pg_catalog.pg_stat_activity TO postgres;
      `);
    } finally {
      await adminSql.end({ timeout: 5 });
    }
  }

  /** Drops tables, triggers, functions, and policies for a clean slate. */
  async function cleanSlate() {
    // Drop policies (no IF EXISTS for policies, so use dynamic DO block)
    await sql.unsafe(`
      DO $$ DECLARE pol RECORD; BEGIN
        FOR pol IN
          SELECT policyname, tablename FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename IN ('resource_metadata', 'resource_versions')
        LOOP
          EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, pol.tablename);
        END LOOP;
      END $$
    `);

    // Drop tables (CASCADE removes triggers, indexes, constraints, FK refs)
    await sql.unsafe(`DROP TABLE IF EXISTS public.resource_versions CASCADE`);
    await sql.unsafe(`DROP TABLE IF EXISTS public.resource_metadata CASCADE`);

    // Drop enum type (CASCADE needed since columns reference it).
    // Use DO block to avoid "type does not exist" errors.
    await sql.unsafe(`DROP TYPE IF EXISTS public.resource_type CASCADE`);

    // Drop trigger functions
    await sql.unsafe(`DROP FUNCTION IF EXISTS _tempest.reject_versioned_row_update()`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS _tempest.reject_resource_id_change()`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS _tempest.reject_versioned_row_delete()`);
  }

  beforeAll(async () => {
    await ensurePrerequisites();
  });

  beforeEach(async () => {
    await cleanSlate();
    await sql.unsafe(MIGRATION_SQL);
    adapter = new PostgresAdapter(sql, "u1");
    await adapter.init();
  });

  afterEach(async () => {
    await cleanSlate();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Provision a document resource with sensible defaults. */
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

  /** Provision a ref-type resource with sensible defaults. */
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

  /** Read a raw row from resource_versions using superuser connection. */
  async function rawDraft(resourceId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM public.resource_versions
      WHERE resource_id = ${resourceId} AND version IS NULL
    `;
    return rows[0];
  }

  /** Read a raw row from resource_versions by version. */
  async function rawVersion(
    resourceId: string,
    version: number,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM public.resource_versions
      WHERE resource_id = ${resourceId} AND version = ${version}
    `;
    return rows[0];
  }

  /** Directly update draft data/dirty using superuser connection (bypasses RLS). */
  async function dirtyDraft(resourceId: string, data: readonly { item: string }[]) {
    await sql`
      UPDATE public.resource_versions
      SET data = ${sql.json(data)}, dirty = TRUE
      WHERE resource_id = ${resourceId} AND version IS NULL
    `;
  }

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  describe("init", () => {
    test("is idempotent — calling init twice does not throw", async () => {
      await expect(adapter.init()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // destroy()
  // -------------------------------------------------------------------------

  describe("destroy", () => {
    test("closes the connection pool", async () => {
      // Create a separate adapter with its own connection to avoid closing the shared pool
      const separateSql = postgres(POSTGRES_URL, { max: 1, idle_timeout: 5, connect_timeout: 5 });
      const separateAdapter = new PostgresAdapter(separateSql, "u1");

      await separateAdapter.destroy();

      // After destroy, queries on the closed pool should fail
      await expect(separateSql`SELECT 1`).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // provision()
  // -------------------------------------------------------------------------

  describe("provision", () => {
    test("inserts metadata + draft + version 1 and returns ResourceMetadata", async () => {
      const result = await provisionDoc("tasks", [], {
        name: "Tasks",
        description: "Task list",
        schema: { type: "array" },
      });

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
      const draft = await rawDraft(result.id);
      expect(draft).toBeDefined();
      expect(draft?.dirty).toBe(false);
      expect(draft?.data).toEqual([]);
      expect(draft?.schema).toEqual({ type: "array" });

      // Verify version 1 row exists
      const v1 = await rawVersion(result.id, 1);
      expect(v1).toBeDefined();
      expect(v1?.dirty).toBe(false);
      expect(v1?.data).toEqual([]);
    });

    test("upsert on duplicate slug updates metadata and draft schema, preserves data", async () => {
      const first = await provisionDoc("tasks", [{ item: "eggs" }], {
        name: "Tasks",
        description: "Task list",
        schema: { type: "array" },
      });

      // Simulate agent mutation via superuser (bypasses RLS for test setup)
      await sql`
        UPDATE public.resource_versions
        SET data = ${sql.json([{ item: "eggs" }, { item: "bread" }])}
        WHERE resource_id = ${first.id} AND version IS NULL
      `;

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
      const draft = await rawDraft(first.id);
      expect(draft?.data).toEqual([{ item: "eggs" }, { item: "bread" }]);

      // Draft schema updated
      expect(draft?.schema).toEqual({ type: "array", items: { type: "object" } });

      // No duplicate version 1
      const versions = await sql<Record<string, unknown>[]>`
        SELECT * FROM public.resource_versions
        WHERE resource_id = ${first.id} AND version IS NOT NULL
      `;
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // publish()
  // -------------------------------------------------------------------------

  describe("publish", () => {
    test("snapshots dirty draft as new version and clears dirty flag", async () => {
      const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

      // Dirty the draft
      await dirtyDraft(resource.id, [{ item: "eggs" }]);

      const result = await adapter.publish("ws1", "tasks");

      expect(result).toEqual({ version: 2 });

      // Metadata current_version bumped
      const [meta] = await sql<{ current_version: number }[]>`
        SELECT current_version FROM public.resource_metadata WHERE id = ${resource.id}
      `;
      expect(meta?.current_version).toBe(2);

      // New version 2 row exists with correct data
      const v2 = await rawVersion(resource.id, 2);
      expect(v2).toBeDefined();
      expect(v2?.dirty).toBe(false);
      expect(v2?.data).toEqual([{ item: "eggs" }]);

      // Draft dirty flag cleared
      const draft = await rawDraft(resource.id);
      expect(draft?.dirty).toBe(false);
    });

    test("returns null version when draft is not dirty", async () => {
      await provisionDoc("tasks", []);

      const result = await adapter.publish("ws1", "tasks");
      expect(result).toEqual({ version: null });
    });

    test("throws when resource does not exist", async () => {
      await expect(adapter.publish("ws1", "nonexistent")).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // query()
  // -------------------------------------------------------------------------

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
          `SELECT elem->>'item' AS item,
                  (elem->>'quantity')::int AS quantity
           FROM draft, jsonb_array_elements(draft.data) elem`,
        );

        expect(result.rowCount).toBe(3);
        expect(result.rows).toEqual(groceryData);
      });

      test("SELECT with WHERE filters rows", async () => {
        const result = await adapter.query(
          "ws1",
          "grocery_list",
          `SELECT elem->>'item' AS item,
                  (elem->>'quantity')::int AS quantity
           FROM draft, jsonb_array_elements(draft.data) elem
           WHERE (elem->>'quantity')::int > 1`,
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
          `SELECT COUNT(*) AS total_items,
                  SUM((elem->>'quantity')::int) AS total_quantity
           FROM draft, jsonb_array_elements(draft.data) elem`,
        );

        expect(result.rowCount).toBe(1);
        // postgres.js returns bigint for COUNT, cast to number for comparison
        expect(Number(result.rows[0]?.total_items)).toBe(3);
        expect(Number(result.rows[0]?.total_quantity)).toBe(15);
      });

      test("supports parameterized queries", async () => {
        const result = await adapter.query(
          "ws1",
          "grocery_list",
          `SELECT elem->>'item' AS item
           FROM draft, jsonb_array_elements(draft.data) elem
           WHERE elem->>'item' = $1`,
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
      const resource = await provisionDoc("grocery_list", [{ item: "eggs" }]);

      // Dirty and publish to create version 2
      await dirtyDraft(resource.id, [{ item: "eggs" }, { item: "bread" }]);
      await adapter.publish("ws1", "grocery_list");

      // Dirty draft again (unpublished)
      await dirtyDraft(resource.id, [{ item: "eggs" }, { item: "bread" }, { item: "milk" }]);

      // Query should see the draft (3 items), not version 2 (2 items)
      const result = await adapter.query(
        "ws1",
        "grocery_list",
        "SELECT elem->>'item' AS item FROM draft, jsonb_array_elements(draft.data) elem",
      );

      expect(result.rowCount).toBe(3);
    });

    test("throws when resource does not exist", async () => {
      await expect(adapter.query("ws1", "nonexistent", "SELECT * FROM draft")).rejects.toThrow(
        /not found/i,
      );
    });

    test("rejects query on non-document resource type", async () => {
      await provisionRef("sheet_ref", { provider: "google-sheets", ref: "https://example.com" });

      await expect(adapter.query("ws1", "sheet_ref", "SELECT * FROM draft")).rejects.toThrow(
        /document/i,
      );
    });

    test("scopes query to correct workspace", async () => {
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
        "SELECT elem->>'task' AS task FROM draft, jsonb_array_elements(draft.data) elem",
      );

      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ task: "ws1 task" }]);
    });

    test("enriches SQL errors with schema context", async () => {
      const schema = { type: "object", properties: { item: { type: "string" } } };
      await provisionDoc("items", [{ item: "a" }], { schema });

      const err = await adapter
        .query("ws1", "items", "SELECT nonexistent_column FROM draft")
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Resource schema:");
      expect((err as Error).message).toContain('"type":"object"');
    });
  });

  // -------------------------------------------------------------------------
  // mutate()
  // -------------------------------------------------------------------------

  describe("mutate", () => {
    test("INSERT — appends a row to JSONB array and sets dirty", async () => {
      const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

      const result = await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'eggs', 'quantity', 12)) FROM draft",
      );

      expect(result).toEqual({ applied: true });

      // Verify draft data was updated
      const draft = await rawDraft(resource.id);
      expect(draft?.dirty).toBe(true);
      expect(draft?.data).toEqual([{ item: "eggs", quantity: 12 }]);
    });

    test("UPDATE — modifies existing row in JSONB array", async () => {
      const resource = await provisionDoc("tasks", [{ item: "eggs", quantity: 6 }], {
        schema: { type: "array" },
      });

      const result = await adapter.mutate(
        "ws1",
        "tasks",
        `SELECT jsonb_agg(
          CASE
            WHEN elem->>'item' = 'eggs'
            THEN jsonb_set(elem, '{quantity}', '24')
            ELSE elem
          END
        )
        FROM draft, jsonb_array_elements(draft.data) elem`,
      );

      expect(result).toEqual({ applied: true });

      const draft = await rawDraft(resource.id);
      expect(draft?.data).toEqual([{ item: "eggs", quantity: 24 }]);
    });

    test("DELETE — removes rows from JSONB array via filter", async () => {
      const resource = await provisionDoc(
        "tasks",
        [
          { item: "eggs", quantity: 12 },
          { item: "bread", quantity: 0 },
          { item: "milk", quantity: 2 },
        ],
        { schema: { type: "array" } },
      );

      const result = await adapter.mutate(
        "ws1",
        "tasks",
        `SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM draft, jsonb_array_elements(draft.data) elem
         WHERE (elem->>'quantity')::int > 0`,
      );

      expect(result).toEqual({ applied: true });

      const draft = await rawDraft(resource.id);
      expect(draft?.data).toEqual([
        { item: "eggs", quantity: 12 },
        { item: "milk", quantity: 2 },
      ]);
    });

    test("multiple mutations accumulate dirty state", async () => {
      const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

      // First mutation: add eggs
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'eggs', 'quantity', 12)) FROM draft",
      );

      // Second mutation: add bread
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'bread', 'quantity', 1)) FROM draft",
      );

      // Both accumulated
      const draft = await rawDraft(resource.id);
      expect(draft?.dirty).toBe(true);
      expect(draft?.data).toEqual([
        { item: "eggs", quantity: 12 },
        { item: "bread", quantity: 1 },
      ]);
    });

    test("supports parameterized queries for prose replacement", async () => {
      await provisionDoc("notes", "", {
        name: "Notes",
        description: "Meeting notes",
        schema: { type: "string", format: "markdown" },
      });

      const result = await adapter.mutate("ws1", "notes", "SELECT $1 FROM draft", [
        "# Updated Notes\n\nNew content here",
      ]);

      expect(result).toEqual({ applied: true });

      const [draft] = await sql<{ data: unknown }[]>`
        SELECT rv.data FROM public.resource_versions rv
        JOIN public.resource_metadata rm ON rv.resource_id = rm.id
        WHERE rm.slug = 'notes' AND rm.workspace_id = 'ws1' AND rv.version IS NULL
      `;
      expect(draft?.data).toBe("# Updated Notes\n\nNew content here");
    });

    test("throws when resource does not exist", async () => {
      await expect(
        adapter.mutate("ws1", "nonexistent", "SELECT draft.data FROM draft"),
      ).rejects.toThrow(/not found/i);
    });

    test("throws for non-document resource types", async () => {
      await provisionRef("sheet-ref", { provider: "google-sheets", ref: "https://example.com" });

      await expect(
        adapter.mutate("ws1", "sheet-ref", "SELECT draft.data FROM draft"),
      ).rejects.toThrow(/document/i);
    });

    test("throws on invalid SQL", async () => {
      await provisionDoc("tasks", [], { schema: { type: "array" } });

      await expect(adapter.mutate("ws1", "tasks", "THIS IS NOT VALID SQL")).rejects.toThrow();
    });

    test("increments draft_version on each mutation", async () => {
      const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

      // draft_version starts at 0
      const before = await rawDraft(resource.id);
      expect(before?.draft_version).toBe(0);

      // First mutation
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'eggs')) FROM draft",
      );

      const after1 = await rawDraft(resource.id);
      expect(after1?.draft_version).toBe(1);

      // Second mutation
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'bread')) FROM draft",
      );

      const after2 = await rawDraft(resource.id);
      expect(after2?.draft_version).toBe(2);
    });

    test("stale draft_version UPDATE affects zero rows", async () => {
      const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

      // Mutate to bump draft_version to 1
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'eggs')) FROM draft",
      );

      // Simulate a stale write: attempt UPDATE with draft_version = 0 (already bumped to 1)
      const result = await sql`
        UPDATE public.resource_versions
        SET data = '[]'::jsonb, dirty = TRUE, draft_version = draft_version + 1
        WHERE resource_id = ${resource.id} AND version IS NULL AND draft_version = 0
      `;

      // Stale version should affect zero rows — the optimistic check rejected it
      expect(result.count).toBe(0);

      // Original data should be untouched
      const draft = await rawDraft(resource.id);
      expect(draft?.data).toEqual([{ item: "eggs" }]);
    });

    test("publish resets draft_version to 0", async () => {
      const resource = await provisionDoc("tasks", [], { schema: { type: "array" } });

      // Mutate to bump draft_version
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'eggs')) FROM draft",
      );

      const beforePublish = await rawDraft(resource.id);
      expect(beforePublish?.draft_version).toBe(1);

      await adapter.publish("ws1", "tasks");

      const afterPublish = await rawDraft(resource.id);
      expect(afterPublish?.draft_version).toBe(0);
    });

    test("resetDraft resets draft_version to 0", async () => {
      const resource = await provisionDoc("tasks", [{ item: "original" }]);

      // Mutate to bump draft_version
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'extra')) FROM draft",
      );

      const beforeReset = await rawDraft(resource.id);
      expect(beforeReset?.draft_version).toBe(1);

      await adapter.resetDraft("ws1", "tasks");

      const afterReset = await rawDraft(resource.id);
      expect(afterReset?.draft_version).toBe(0);
    });

    test("throws after exhausting retry attempts on persistent conflict", async () => {
      const resource = await provisionDoc("tasks", []);

      // Install a trigger that silently prevents CAS updates on the draft row,
      // simulating a permanent concurrent modification conflict.
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION trg_force_conflict() RETURNS trigger AS $$
        BEGIN
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
      `);
      await sql.unsafe(`
        CREATE TRIGGER trg_force_conflict
        BEFORE UPDATE OF data ON public.resource_versions
        FOR EACH ROW
        WHEN (OLD.version IS NULL AND NEW.dirty = TRUE)
        EXECUTE FUNCTION trg_force_conflict()
      `);

      try {
        await expect(
          adapter.mutate(
            "ws1",
            "tasks",
            "SELECT draft.data || jsonb_build_array(jsonb_build_object('item', 'eggs')) FROM draft",
          ),
        ).rejects.toThrow(/exhausted 3 retries/);
      } finally {
        await sql.unsafe("DROP TRIGGER IF EXISTS trg_force_conflict ON public.resource_versions");
        await sql.unsafe("DROP FUNCTION IF EXISTS trg_force_conflict()");
      }

      // Verify original data is untouched
      const draft = await rawDraft(resource.id);
      expect(draft?.data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // listResources()
  // -------------------------------------------------------------------------

  describe("listResources", () => {
    test("returns all non-deleted resources for a workspace", async () => {
      await provisionDoc("tasks", []);
      await provisionDoc("notes", []);

      const resources = await adapter.listResources("ws1");
      expect(resources).toHaveLength(2);
      expect(resources.map((r) => r.slug).sort()).toEqual(["notes", "tasks"]);
    });

    test("excludes deleted resources", async () => {
      await provisionDoc("tasks", []);
      await provisionDoc("notes", []);

      await adapter.deleteResource("ws1", "tasks");

      const resources = await adapter.listResources("ws1");
      expect(resources).toHaveLength(1);
      expect(resources[0]?.slug).toBe("notes");
    });

    test("returns empty array when workspace has no resources", async () => {
      const resources = await adapter.listResources("ws-empty");
      expect(resources).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getResource()
  // -------------------------------------------------------------------------

  describe("getResource", () => {
    test("returns draft version by default", async () => {
      const meta = await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      const result = await adapter.getResource("ws1", "tasks");
      expect(result).not.toBeNull();
      expect(result?.metadata.id).toBe(meta.id);
      expect(result?.metadata.slug).toBe("tasks");
      expect(result?.version.version).toBeNull();
      expect(result?.version.resourceId).toBe(meta.id);
    });

    test("returns latest published version when published: true", async () => {
      const meta = await provisionDoc("tasks", [{ item: "eggs" }]);

      // Dirty and publish to create version 2
      await dirtyDraft(meta.id, [{ item: "eggs" }, { item: "bread" }]);
      await adapter.publish("ws1", "tasks");

      const result = await adapter.getResource("ws1", "tasks", { published: true });
      expect(result).not.toBeNull();
      expect(result?.version.version).toBe(2);
    });

    test("returns null for nonexistent resource", async () => {
      const result = await adapter.getResource("ws1", "nonexistent");
      expect(result).toBeNull();
    });

    test("returns null for deleted resource", async () => {
      await provisionDoc("tasks", []);
      await adapter.deleteResource("ws1", "tasks");

      const result = await adapter.getResource("ws1", "tasks");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // deleteResource()
  // -------------------------------------------------------------------------

  describe("deleteResource", () => {
    test("deletes resource and its versions via CASCADE", async () => {
      const meta = await provisionDoc("tasks", []);

      await adapter.deleteResource("ws1", "tasks");

      // Metadata row should be gone
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM public.resource_metadata
        WHERE workspace_id = 'ws1' AND slug = 'tasks'
      `;
      expect(row).toBeUndefined();

      // Version rows should be gone (ON DELETE CASCADE)
      const versions = await sql<{ id: string }[]>`
        SELECT id FROM public.resource_versions
        WHERE resource_id = ${meta.id}
      `;
      expect(versions).toHaveLength(0);
    });

    test("throws when resource does not exist", async () => {
      await expect(adapter.deleteResource("ws1", "nonexistent")).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // resetDraft()
  // -------------------------------------------------------------------------

  describe("resetDraft", () => {
    test("reverts draft data to latest published version and clears dirty", async () => {
      const meta = await provisionDoc("tasks", [{ item: "eggs" }]);

      // Dirty the draft
      await dirtyDraft(meta.id, [{ item: "MUTATED" }]);

      await adapter.resetDraft("ws1", "tasks");

      const draft = await rawDraft(meta.id);
      expect(draft?.dirty).toBe(false);
      expect(draft?.data).toEqual([{ item: "eggs" }]);
    });

    test("reverts to latest published version after multiple publishes", async () => {
      const meta = await provisionDoc("tasks", [{ item: "v1" }]);

      // Publish version 2
      await dirtyDraft(meta.id, [{ item: "v2" }]);
      await adapter.publish("ws1", "tasks");

      // Dirty draft again
      await dirtyDraft(meta.id, [{ item: "dirty" }]);

      await adapter.resetDraft("ws1", "tasks");

      const draft = await rawDraft(meta.id);
      expect(draft?.data).toEqual([{ item: "v2" }]);
    });

    test("throws when resource does not exist", async () => {
      await expect(adapter.resetDraft("ws1", "nonexistent")).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // replaceVersion()
  // -------------------------------------------------------------------------

  describe("replaceVersion", () => {
    test("creates new version with given data and resets draft to match", async () => {
      const meta = await provisionDoc("tasks", []);

      const replacement = [{ item: "imported" }];
      const version = await adapter.replaceVersion("ws1", "tasks", replacement);

      expect(version.version).toBe(2);
      expect(version.resourceId).toBe(meta.id);

      // New version row in DB
      const v2 = await rawVersion(meta.id, 2);
      expect(v2?.data).toEqual(replacement);

      // Draft reset to match
      const draft = await rawDraft(meta.id);
      expect(draft?.data).toEqual(replacement);
      expect(draft?.dirty).toBe(false);

      // Metadata current_version bumped
      const [updatedMeta] = await sql<{ current_version: number }[]>`
        SELECT current_version FROM public.resource_metadata WHERE id = ${meta.id}
      `;
      expect(updatedMeta?.current_version).toBe(2);
    });

    test("accepts optional schema override", async () => {
      const meta = await provisionDoc("tasks", [], { schema: { type: "array" } });

      const newSchema = { type: "array", items: { type: "string" } };
      const version = await adapter.replaceVersion("ws1", "tasks", ["hello"], newSchema);

      if (!version.version) throw new Error("expected version");
      const row = await rawVersion(meta.id, version.version);
      expect(row?.schema).toEqual(newSchema);
    });

    test("throws when resource does not exist", async () => {
      await expect(adapter.replaceVersion("ws1", "nonexistent", [])).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // linkRef()
  // -------------------------------------------------------------------------

  describe("linkRef", () => {
    test("creates new version with ref data", async () => {
      const meta = await provisionRef("report", { ref: null });

      const version = await adapter.linkRef("ws1", "report", "artifact://abc123");

      expect(version.version).toBe(2);
      expect(version.resourceId).toBe(meta.id);

      const v2 = await rawVersion(meta.id, 2);
      expect(v2?.data).toEqual({ ref: "artifact://abc123" });
    });

    test("bumps metadata current_version and resets draft", async () => {
      const meta = await provisionRef("report", { ref: null });

      await adapter.linkRef("ws1", "report", "artifact://abc123");

      const [updatedMeta] = await sql<{ current_version: number }[]>`
        SELECT current_version FROM public.resource_metadata WHERE id = ${meta.id}
      `;
      expect(updatedMeta?.current_version).toBe(2);

      const draft = await rawDraft(meta.id);
      expect(draft?.data).toEqual({ ref: "artifact://abc123" });
      expect(draft?.dirty).toBe(false);
    });

    test("throws for document resource type", async () => {
      await provisionDoc("grocery-list", { items: [] });

      await expect(adapter.linkRef("ws1", "grocery-list", "https://example.com")).rejects.toThrow(
        /external_ref/i,
      );
    });

    test("throws when resource does not exist", async () => {
      await expect(adapter.linkRef("ws1", "nonexistent", "ref://foo")).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // publishAllDirty()
  // -------------------------------------------------------------------------

  describe("publishAllDirty", () => {
    test("publishes only dirty drafts and returns metadata", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }]);
      await provisionDoc("notes", ["note1"]);
      await provisionDoc("clean", []);

      // Dirty tasks and notes via mutate
      await adapter.mutate(
        "ws1",
        "tasks",
        "SELECT jsonb_set(draft.data, '{0,item}', '\"bread\"') FROM draft",
      );
      await adapter.mutate("ws1", "notes", "SELECT draft.data || '\"note2\"'::jsonb FROM draft");

      const published = await adapter.publishAllDirty("ws1");
      expect(published).toHaveLength(2);
      expect(published.map((p) => p.slug).sort()).toEqual(["notes", "tasks"]);

      // Verify version 2 exists for published resources
      const tasksV2 = await adapter.getResource("ws1", "tasks", { published: true });
      expect(tasksV2?.version.version).toBe(2);

      const notesV2 = await adapter.getResource("ws1", "notes", { published: true });
      expect(notesV2?.version.version).toBe(2);
    });

    test("returns empty array when no drafts are dirty", async () => {
      await provisionDoc("tasks", []);

      const published = await adapter.publishAllDirty("ws1");
      expect(published).toHaveLength(0);
    });

    test("scopes to workspace — does not publish dirty drafts in other workspaces", async () => {
      await provisionDoc("data", []);
      await adapter.provision(
        "ws2",
        {
          userId: "u1",
          slug: "data",
          name: "data",
          description: "d",
          type: "document",
          schema: {},
        },
        [],
      );

      // Dirty both workspaces
      await adapter.mutate("ws1", "data", "SELECT '[]'::jsonb FROM draft");
      await adapter.mutate("ws2", "data", "SELECT '[]'::jsonb FROM draft");

      // Publish only ws1
      const published = await adapter.publishAllDirty("ws1");
      expect(published).toHaveLength(1);

      // ws2 should still have dirty draft (no version 2)
      const ws2Published = await adapter.getResource("ws2", "data", { published: true });
      expect(ws2Published?.version.version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getSkill()
  // -------------------------------------------------------------------------

  describe("getSkill", () => {
    test("returns Postgres skill text", async () => {
      const skill = await adapter.getSkill();

      expect(skill).toContain("# Resource Data Access (Postgres)");
      expect(skill).toContain("resource_read");
      expect(skill).toContain("jsonb_array_elements");
    });
  });

  // -------------------------------------------------------------------------
  // RLS isolation
  // -------------------------------------------------------------------------

  describe("RLS isolation", () => {
    test("user A cannot see user B resources", async () => {
      // User A provisions a resource
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "secret",
          name: "Secret",
          description: "User A secret",
          type: "document",
          schema: {},
        },
        { data: "user-a-only" },
      );

      // User B should not see it
      const adapterB = new PostgresAdapter(sql, "user-b");
      const result = await adapterB.getResource("ws1", "secret");
      expect(result).toBeNull();

      // User B list should be empty
      const list = await adapterB.listResources("ws1");
      expect(list).toHaveLength(0);
    });

    test("user A cannot delete user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "protected",
          name: "Protected",
          description: "Protected",
          type: "document",
          schema: {},
        },
        [],
      );

      // User B tries to delete
      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(adapterB.deleteResource("ws1", "protected")).rejects.toThrow();

      // Still exists for user A
      const result = await adapterA.getResource("ws1", "protected");
      expect(result).not.toBeNull();
    });

    test("user A cannot query user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "private-data",
          name: "Private",
          description: "Private data",
          type: "document",
          schema: {},
        },
        [{ secret: "hidden" }],
      );

      // User B tries to query user A's resource
      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(adapterB.query("ws1", "private-data", "SELECT * FROM draft")).rejects.toThrow(
        /not found/i,
      );
    });

    test("user A cannot publish user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "private-publish",
          name: "Private",
          description: "Private",
          type: "document",
          schema: {},
        },
        [{ secret: "hidden" }],
      );

      // Dirty the draft so publish would do something
      const [meta] = await sql<{ id: string }[]>`
        SELECT id FROM public.resource_metadata WHERE slug = 'private-publish' AND workspace_id = 'ws1'
      `;
      if (meta) {
        await sql`UPDATE public.resource_versions SET dirty = TRUE WHERE resource_id = ${meta.id} AND version IS NULL`;
      }

      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(adapterB.publish("ws1", "private-publish")).rejects.toThrow(/not found/i);
    });

    test("user A cannot replaceVersion on user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "private-replace",
          name: "Private",
          description: "Private",
          type: "document",
          schema: {},
        },
        [],
      );

      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(
        adapterB.replaceVersion("ws1", "private-replace", [{ hacked: true }]),
      ).rejects.toThrow(/not found/i);
    });

    test("user A cannot linkRef on user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "private-ref",
          name: "Private Ref",
          description: "Private",
          type: "external_ref",
          schema: {},
        },
        { ref: null },
      );

      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(adapterB.linkRef("ws1", "private-ref", "hacked://ref")).rejects.toThrow(
        /not found/i,
      );
    });

    test("user A cannot resetDraft on user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "private-reset",
          name: "Private",
          description: "Private",
          type: "document",
          schema: {},
        },
        [],
      );

      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(adapterB.resetDraft("ws1", "private-reset")).rejects.toThrow(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Agent SQL sandboxing
  // -------------------------------------------------------------------------

  describe("agent SQL sandboxing", () => {
    // -- Table access restrictions (AST validator + DB-level role) --

    test("agent SQL cannot access real tables", async () => {
      await provisionDoc("tasks", [], { schema: { type: "array" } });

      await expect(
        adapter.query("ws1", "tasks", "SELECT id FROM public.resource_metadata LIMIT 1"),
      ).rejects.toThrow(/not allowed/i);
    });

    test("agent SQL cannot call set_config", async () => {
      await provisionDoc("tasks", [], { schema: { type: "array" } });

      // Caught by AST validator (defense-in-depth: DB REVOKE also blocks it)
      await expect(
        adapter.query("ws1", "tasks", "SELECT set_config('request.user_id', 'hacker', true)"),
      ).rejects.toThrow(/not allowed/i);
    });

    test("agent SQL can only read draft temp table", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      const result = await adapter.query("ws1", "tasks", "SELECT draft.data FROM draft");
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.data).toEqual([{ item: "eggs" }]);
    });

    test("agent SQL cannot modify the draft temp table", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      // UPDATE rejected by AST validator (only SELECT allowed)
      await expect(
        adapter.query("ws1", "tasks", "UPDATE draft SET data = '[]'::jsonb RETURNING data"),
      ).rejects.toThrow(/only select/i);
    });

    test("agent mutate SQL cannot access real tables", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(
        adapter.mutate(
          "ws1",
          "tasks",
          "SELECT (SELECT id FROM public.resource_metadata LIMIT 1) FROM draft",
        ),
      ).rejects.toThrow(/not allowed/i);
    });

    // -- String literal false positive regression --
    // Keywords inside string literals must not trigger the AST validator.

    test.each([
      [
        `SELECT elem->>'item' AS item FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'status' = 'reset'`,
        "keyword 'reset' in string literal",
      ],
      [
        `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'action' = 'set'`,
        "keyword 'set' in string literal",
      ],
      [
        `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'op' = 'execute'`,
        "keyword 'execute' in string literal",
      ],
      [
        `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'mode' = 'do'`,
        "keyword 'do' in string literal",
      ],
      [
        `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'state' = 'rollback'`,
        "keyword 'rollback' in string literal",
      ],
      [
        `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'cmd' = 'truncate'`,
        "keyword 'truncate' in string literal",
      ],
    ])("allows keywords in string literals: %s (%s)", async (legitimateSql) => {
      await provisionDoc("tasks", [{ item: "eggs", status: "reset" }], {
        schema: { type: "array" },
      });
      const result = await adapter.query("ws1", "tasks", legitimateSql);
      expect(result).toBeDefined();
    });

    // -- Post-execution verification (happy path) --
    // Verify the post-execution context check runs and passes for legitimate queries.

    test("post-execution verify passes for legitimate query (role + user context intact)", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      // A successful query implicitly proves the post-execution verify passed
      // (it checks current_user = agent_query AND request.user_id = userId).
      const result = await adapter.query("ws1", "tasks", "SELECT draft.data FROM draft");
      expect(result.rowCount).toBe(1);
    });

    test("post-execution verify passes for legitimate mutate", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      const result = await adapter.mutate("ws1", "tasks", "SELECT draft.data FROM draft");
      expect(result).toEqual({ applied: true });
    });

    // -- Bind parameter size limit --

    test("rejects oversized bind parameters", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      const oversizedParam = "x".repeat(1024 * 1024 + 1);
      await expect(
        adapter.query("ws1", "tasks", "SELECT $1 FROM draft", [oversizedParam]),
      ).rejects.toThrow(/exceeds maximum size/i);
    });

    test("rejects oversized bind parameters in mutate", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      const oversizedParam = "x".repeat(1024 * 1024 + 1);
      await expect(
        adapter.mutate("ws1", "tasks", "SELECT $1 FROM draft", [oversizedParam]),
      ).rejects.toThrow(/exceeds maximum size/i);
    });

    // -- JSONB payload size limit --

    test("rejects oversized JSONB data in provision", async () => {
      const oversizedData = { huge: "x".repeat(5 * 1024 * 1024 + 1) };

      await expect(
        adapter.provision(
          "ws1",
          {
            userId: "u1",
            slug: "huge",
            name: "Huge",
            description: "big",
            type: "document",
            schema: {},
          },
          oversizedData,
        ),
      ).rejects.toThrow(/exceeds maximum size/i);
    });

    test("rejects oversized JSONB data in replaceVersion", async () => {
      await provisionDoc("tasks", []);

      const oversizedData = { huge: "x".repeat(5 * 1024 * 1024 + 1) };
      await expect(adapter.replaceVersion("ws1", "tasks", oversizedData)).rejects.toThrow(
        /exceeds maximum size/i,
      );
    });

    // -- DB-level TRUNCATE enforcement --

    test("TRUNCATE is blocked by AST validator", async () => {
      await provisionDoc("tasks", [], { schema: { type: "array" } });

      await expect(adapter.query("ws1", "tasks", "TRUNCATE draft")).rejects.toThrow(/only select/i);
    });

    // -- Verify mutate() path has the same validator --

    test("mutate blocks DO anonymous blocks", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(
        adapter.mutate("ws1", "tasks", "DO $$ BEGIN SET LOCAL ROLE authenticated; END $$"),
      ).rejects.toThrow(/only select/i);
    });

    test("mutate blocks SET/RESET", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(adapter.mutate("ws1", "tasks", "RESET ROLE")).rejects.toThrow(/only select/i);
    });

    test("mutate blocks pg_sleep", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(
        adapter.mutate("ws1", "tasks", "SELECT pg_sleep(100) FROM draft"),
      ).rejects.toThrow(/not allowed/i);
    });

    // -- Multi-statement injection prevention ({ simple: false }) --

    test("rejects multi-statement SQL via extended query protocol", async () => {
      await provisionDoc("tasks", [], { schema: { type: "array" } });

      // Neither statement matches the deny-list, but { simple: false } forces
      // extended protocol which only allows a single statement per call.
      await expect(
        adapter.query("ws1", "tasks", "SELECT 1 FROM draft; SELECT 2 FROM draft"),
      ).rejects.toThrow();
    });

    test("mutate rejects multi-statement SQL via extended query protocol", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(
        adapter.mutate(
          "ws1",
          "tasks",
          "SELECT draft.data FROM draft; SELECT draft.data FROM draft",
        ),
      ).rejects.toThrow();
    });

    test("simple: false on postgres.js unsafe() rejects multi-statement SQL at DB level", async () => {
      // Regression test: verify that { simple: false } forces extended query
      // protocol independent of the AST validator. This is defense-in-depth —
      // if the AST validator ever had a bug that let multi-statement SQL through,
      // the database itself must still reject it.
      // Uses a raw connection to bypass the adapter's AST validation layer.
      await expect(
        sql.unsafe("SELECT 1; SELECT 2", [], {
          // @ts-expect-error postgres.js unsafe() accepts `simple` at runtime but types omit it
          simple: false,
        }),
      ).rejects.toThrow();

      // Verify single statement still works with { simple: false }
      const rows = await sql.unsafe<{ result: number }[]>("SELECT 1 AS result", [], {
        // @ts-expect-error postgres.js unsafe() accepts `simple` at runtime but types omit it
        simple: false,
      });
      expect(rows[0]?.result).toBe(1);
    });

    // -- DB-level permission enforcement --

    test("agent SQL cannot INSERT into draft temp table", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(
        adapter.query(
          "ws1",
          "tasks",
          "INSERT INTO draft (data, schema) VALUES ('[]'::jsonb, '{}'::jsonb) RETURNING data",
        ),
      ).rejects.toThrow(/only select/i);
    });

    test("agent SQL cannot DELETE from draft temp table", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      await expect(
        adapter.query("ws1", "tasks", "DELETE FROM draft RETURNING data"),
      ).rejects.toThrow(/only select/i);
    });

    // -- Cross-user mutate RLS --

    test("user A cannot mutate user B resources", async () => {
      const adapterA = new PostgresAdapter(sql, "user-a");
      await adapterA.provision(
        "ws1",
        {
          userId: "user-a",
          slug: "private-mutate",
          name: "Private",
          description: "Private data",
          type: "document",
          schema: {},
        },
        [{ secret: "hidden" }],
      );

      const adapterB = new PostgresAdapter(sql, "user-b");
      await expect(
        adapterB.mutate("ws1", "private-mutate", "SELECT draft.data FROM draft"),
      ).rejects.toThrow(/not found/i);
    });

    // -- Error sanitization --

    test("sanitizes Postgres error messages to strip internal details", async () => {
      await provisionDoc("tasks", [], { schema: { type: "array" } });

      const err = await adapter
        .query("ws1", "tasks", "SELECT nonexistent_column FROM draft")
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      // Should not contain raw role/schema/table names from Postgres internals
      expect(msg).not.toMatch(/role "agent_query"/);
      expect(msg).not.toMatch(/schema "pg_temp/);
    });

    test("sanitizes table and function names in mutate error messages", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      const err = await adapter
        .mutate("ws1", "tasks", "SELECT nonexistent_column FROM draft")
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/role "agent_query"/);
      expect(msg).not.toMatch(/schema "pg_temp/);
    });

    // -- Verify legitimate JSONB operations still work --

    test("jsonb_set is not blocked by SET pattern", async () => {
      await provisionDoc("tasks", [{ item: "eggs", qty: 6 }], { schema: { type: "array" } });

      const result = await adapter.query(
        "ws1",
        "tasks",
        `SELECT jsonb_agg(
          CASE WHEN elem->>'item' = 'eggs'
            THEN jsonb_set(elem, '{qty}', '12')
            ELSE elem END)
        FROM draft, jsonb_array_elements(draft.data) elem`,
      );
      expect(result.rowCount).toBe(1);
    });

    test("SQL comments in legitimate queries are stripped without breaking them", async () => {
      await provisionDoc("tasks", [{ item: "eggs" }], { schema: { type: "array" } });

      // Comments are only stripped for deny-list matching, not from the actual SQL
      // sent to Postgres. This query should succeed even with comments.
      const result = await adapter.query(
        "ws1",
        "tasks",
        `SELECT elem->>'item' AS item /* get item name */
         FROM draft, jsonb_array_elements(draft.data) elem
         -- filter logic goes here`,
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.item).toBe("eggs");
    });
  });

  // -------------------------------------------------------------------------
  // Immutability triggers
  // -------------------------------------------------------------------------

  describe("immutability triggers", () => {
    test("rejects UPDATE on published version rows", async () => {
      const meta = await provisionDoc("tasks", [{ item: "original" }]);

      // Try to update version 1 (immutable) via superuser — trigger should reject
      await expect(
        sql`
          UPDATE public.resource_versions
          SET data = '[]'::jsonb
          WHERE resource_id = ${meta.id} AND version = 1
        `,
      ).rejects.toThrow(/immutable/i);
    });

    test("rejects DELETE on published version rows", async () => {
      const meta = await provisionDoc("tasks", [{ item: "original" }]);

      await expect(
        sql`
          DELETE FROM public.resource_versions
          WHERE resource_id = ${meta.id} AND version = 1
        `,
      ).rejects.toThrow(/immutable/i);
    });

    test("allows UPDATE on draft rows", async () => {
      const meta = await provisionDoc("tasks", []);

      // Updating draft (version IS NULL) should succeed
      await expect(
        sql`
          UPDATE public.resource_versions
          SET data = ${sql.json([{ item: "updated" }])}
          WHERE resource_id = ${meta.id} AND version IS NULL
        `,
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // createPostgresAdapter factory (exported)
  // -------------------------------------------------------------------------

  describe("createPostgresAdapter factory", () => {
    // Importing from the module to test the factory
    test("creates an adapter that can init and query", async () => {
      const { createPostgresAdapter } = await import("./postgres-adapter.ts");
      const factoryAdapter = createPostgresAdapter(POSTGRES_URL, {
        max: 1,
        idle_timeout: 300,
        max_lifetime: 900,
        connect_timeout: 30,
      });

      // init is safe — tables already exist from beforeEach
      await factoryAdapter.init();
      await factoryAdapter.destroy();
    });
  });
});
