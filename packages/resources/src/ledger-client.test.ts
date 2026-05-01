import process from "node:process";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createLedgerClient } from "./ledger-client.ts";

// ---------------------------------------------------------------------------
// Mock Ledger server
// ---------------------------------------------------------------------------

const WORKSPACE = "ws-test-1";
const SLUG = "grocery-list";

/** @description In-memory state for the mock server. */
const mockState = {
  metadata: {
    id: "res-1",
    userId: "user-1",
    workspaceId: WORKSPACE,
    slug: SLUG,
    name: "Grocery List",
    description: "Weekly groceries",
    type: "document" as const,
    currentVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  version: {
    id: "ver-1",
    resourceId: "res-1",
    userId: "user-1",
    version: null,
    schema: { type: "object" },
    data: { items: [{ name: "milk" }, { name: "eggs" }] },
    dirty: false,
    createdAt: "2026-01-01T00:00:00Z",
  },
};

/**
 * @description Minimal mock Hono app that mirrors Ledger route shapes.
 * Returns static responses to verify client request/response serialization.
 */
const mockApp = new Hono()
  .post("/v1/resources/:workspaceId/provision", async (c) => {
    const body = await c.req.json();
    return c.json({ ...mockState.metadata, slug: body.slug }, 201);
  })
  .post("/v1/resources/:workspaceId/:slug/query", async (c) => {
    const body = await c.req.json();
    if (body.sql.includes("bad_table")) {
      return c.json({ error: "table not found" }, 500);
    }
    return c.json({ rows: [{ name: "milk" }, { name: "eggs" }], rowCount: 2 });
  })
  .post("/v1/resources/:workspaceId/:slug/mutate", (c) => {
    return c.json({ applied: true });
  })
  .post("/v1/resources/:workspaceId/:slug/publish", (c) => {
    return c.json({ version: 2 });
  })
  .put("/v1/resources/:workspaceId/:slug/version", (c) => {
    return c.json({ ...mockState.version, version: 2, data: { replaced: true } }, 201);
  })
  .get("/v1/resources/:workspaceId", (c) => {
    return c.json([mockState.metadata]);
  })
  .get("/v1/resources/:workspaceId/:slug", (c) => {
    const slug = c.req.param("slug");
    if (slug === "not-found") {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ metadata: mockState.metadata, version: mockState.version });
  })
  .delete("/v1/resources/:workspaceId/:slug", (c) => {
    return c.json({ deleted: true });
  })
  .post("/v1/resources/:workspaceId/:slug/link-ref", (c) => {
    return c.json({ ...mockState.version, version: 2, data: { ref: "new-ref" } }, 201);
  })
  .post("/v1/resources/:workspaceId/:slug/reset-draft", (c) => {
    return c.json({ reset: true });
  })
  .post("/v1/resources/:workspaceId/publish-all-dirty", (c) => {
    return c.json({
      published: 3,
      resources: [
        { resourceId: "r1", slug: "tasks" },
        { resourceId: "r2", slug: "notes" },
        { resourceId: "r3", slug: "data" },
      ],
    });
  })
  .get("/v1/skill", (c) => {
    return c.text("# Resource Data Access (SQLite)\n\nMock skill text for testing");
  });

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Deno.serve>;
let client: ResourceStorageAdapter;

beforeAll(() => {
  // Use port 0 for OS-assigned free port to avoid collisions in parallel test runs
  server = Deno.serve({ port: 0, onListen: () => {} }, mockApp.fetch);
  const addr = server.addr;
  if (!("port" in addr) || typeof addr.port !== "number") {
    throw new Error("Expected server.addr to have a numeric port");
  }
  const { port } = addr;
  client = createLedgerClient(`http://localhost:${port}`);
});

afterAll(async () => {
  await server.shutdown();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLedgerClient", () => {
  test("defaults to localhost:3200 when no URL provided and LEDGER_URL unset", () => {
    const original = process.env.LEDGER_URL;
    delete process.env.LEDGER_URL;
    try {
      const adapter = createLedgerClient();
      expect(adapter).toBeDefined();
    } finally {
      if (original) process.env.LEDGER_URL = original;
    }
  });

  test("init and destroy are no-ops", async () => {
    await client.init();
    await client.destroy();
  });
});

describe("provision", () => {
  test("sends POST and returns metadata", async () => {
    const result = await client.provision(
      WORKSPACE,
      {
        userId: "user-1",
        slug: SLUG,
        name: "Grocery List",
        description: "Weekly groceries",
        type: "document",
        schema: { type: "object" },
      },
      { items: [] },
    );

    expect(result.slug).toBe(SLUG);
    expect(result.workspaceId).toBe(WORKSPACE);
  });
});

describe("query", () => {
  test("sends POST and returns rows", async () => {
    const result = await client.query(WORKSPACE, SLUG, "SELECT * FROM draft");

    expect(result.rowCount).toBe(2);
    expect(result.rows).toHaveLength(2);
  });

  test("throws on server error", async () => {
    await expect(client.query(WORKSPACE, SLUG, "SELECT * FROM bad_table")).rejects.toThrow(
      "Ledger query failed (500)",
    );
  });
});

describe("mutate", () => {
  test("sends POST and returns applied status", async () => {
    const result = await client.mutate(
      WORKSPACE,
      SLUG,
      "SELECT json_set(draft.data, '$.count', 1) FROM draft",
    );

    expect(result.applied).toBe(true);
  });
});

describe("publish", () => {
  test("sends POST and returns version number", async () => {
    const result = await client.publish(WORKSPACE, SLUG);

    expect(result.version).toBe(2);
  });
});

describe("replaceVersion", () => {
  test("sends PUT and returns new version", async () => {
    const result = await client.replaceVersion(WORKSPACE, SLUG, { replaced: true });

    expect(result.version).toBe(2);
  });
});

describe("listResources", () => {
  test("sends GET and returns metadata array", async () => {
    const result = await client.listResources(WORKSPACE);

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe(SLUG);
  });
});

describe("getResource", () => {
  test("sends GET and returns resource with data", async () => {
    const result = await client.getResource(WORKSPACE, SLUG);

    expect(result).not.toBeNull();
    expect(result?.metadata.slug).toBe(SLUG);
    expect(result?.version.data).toEqual({ items: [{ name: "milk" }, { name: "eggs" }] });
  });

  test("returns null for 404", async () => {
    const result = await client.getResource(WORKSPACE, "not-found");

    expect(result).toBeNull();
  });
});

describe("deleteResource", () => {
  test("sends DELETE and resolves void on success", async () => {
    await expect(client.deleteResource(WORKSPACE, SLUG)).resolves.toBeUndefined();
  });
});

describe("linkRef", () => {
  test("sends POST and returns new version", async () => {
    const result = await client.linkRef(WORKSPACE, SLUG, "new-ref");

    expect(result.version).toBe(2);
  });
});

describe("resetDraft", () => {
  test("sends POST and resolves void on success", async () => {
    await expect(client.resetDraft(WORKSPACE, SLUG)).resolves.toBeUndefined();
  });
});

describe("publishAllDirty", () => {
  test("sends POST and returns resource metadata", async () => {
    const result = await client.publishAllDirty(WORKSPACE);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ resourceId: "r1", slug: "tasks" });
  });
});

describe("getSkill", () => {
  test("fetches skill text from Ledger", async () => {
    const result = await client.getSkill();

    expect(result).toContain("# Resource Data Access (SQLite)");
  });
});
