import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

// Set up isolated test environment BEFORE importing routes
const testDir = join(tmpdir(), `skills-routes-test-${Date.now()}`);
mkdirSync(join(testDir, "data"), { recursive: true });
process.env.ATLAS_HOME = testDir;

// Create a test JWT for auth
function createTestJwt(payload: Record<string, unknown>): string {
  const header = { alg: "none", typ: "JWT" };
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode(header)}.${encode(payload)}.`;
}

process.env.ATLAS_KEY = createTestJwt({
  email: "test@example.com",
  sub: "test-user-id",
  user_metadata: { tempest_user_id: "test-tempest-id" },
});

process.env.USER_IDENTITY_ADAPTER = "local";

const { skillsRoutes } = await import("./skills.ts");

// Response schemas
const SkillResponseSchema = z.object({
  skill: z.object({
    id: z.string(),
    namespace: z.string(),
    name: z.string(),
    version: z.number(),
    description: z.string(),
    instructions: z.string(),
    frontmatter: z.record(z.string(), z.unknown()),
    createdBy: z.string(),
    createdAt: z.coerce.date(),
  }),
});

const PublishedResponseSchema = z.object({
  published: z.object({ namespace: z.string(), name: z.string(), version: z.number() }),
});

const SkillsListSchema = z.object({
  skills: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      description: z.string(),
      latestVersion: z.number(),
    }),
  ),
});

const VersionsListSchema = z.object({
  versions: z.array(
    z.object({ version: z.number(), createdAt: z.coerce.date(), createdBy: z.string() }),
  ),
});

const ErrorSchema = z.object({ error: z.string() });

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Skills API Routes - Global Catalog", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLISH
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /@:namespace/:name (publish)", () => {
    it("publishes a text-only skill via JSON body", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "Reviews code for correctness",
          instructions: "Review the code carefully.",
        }),
      });

      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published).toMatchObject({ namespace: "atlas", name: "code-review", version: 1 });
    });

    it("auto-increments version on subsequent publish", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "Reviews code v2",
          instructions: "Review the code more carefully.",
        }),
      });

      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published.version).toBe(2);
    });

    it("rejects publish without description", async () => {
      const response = await skillsRoutes.request("/@atlas/bad-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: "Do stuff" }),
      });

      expect(response.status).toBe(400);
    });

    it("rejects publish without instructions", async () => {
      const response = await skillsRoutes.request("/@atlas/bad-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "A skill" }),
      });

      expect(response.status).toBe(400);
    });

    it("validates namespace format", async () => {
      const response = await skillsRoutes.request("/@Invalid/skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Test", instructions: "Test" }),
      });

      expect(response.status).toBe(400);
    });

    it("validates name format", async () => {
      const response = await skillsRoutes.request("/@atlas/Invalid Name!", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Test", instructions: "Test" }),
      });

      expect(response.status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET LATEST
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /@:namespace/:name (latest)", () => {
    it("returns latest version of a skill", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review");
      expect(response.status).toBe(200);

      const body = SkillResponseSchema.parse(await response.json());
      expect(body.skill).toMatchObject({
        namespace: "atlas",
        name: "code-review",
        version: 2,
        description: "Reviews code v2",
      });
    });

    it("returns 404 for non-existent skill", async () => {
      const response = await skillsRoutes.request("/@atlas/nonexistent");
      expect(response.status).toBe(404);
      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });

    it("does not include archive blob in JSON response", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review");
      const json = (await response.json()) as { skill: Record<string, unknown> };
      expect(json.skill).not.toHaveProperty("archive");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET SPECIFIC VERSION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /@:namespace/:name/:version", () => {
    it("returns specific version", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review/1");
      expect(response.status).toBe(200);

      const body = SkillResponseSchema.parse(await response.json());
      expect(body.skill).toMatchObject({ version: 1, description: "Reviews code for correctness" });
    });

    it("returns 404 for non-existent version", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review/999");
      expect(response.status).toBe(404);
    });

    it("rejects non-integer version", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review/abc");
      expect(response.status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET / (list)", () => {
    it("lists all skills", async () => {
      const response = await skillsRoutes.request("/");
      expect(response.status).toBe(200);

      const body = SkillsListSchema.parse(await response.json());
      expect(body.skills.length).toBeGreaterThan(0);
      expect(body.skills[0]).toMatchObject({
        namespace: "atlas",
        name: "code-review",
        latestVersion: 2,
      });
    });

    it("filters by namespace", async () => {
      // Publish in a different namespace first
      await skillsRoutes.request("/@team/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Deploy skill", instructions: "Deploy things." }),
      });

      const response = await skillsRoutes.request("/?namespace=team");
      expect(response.status).toBe(200);
      const body = SkillsListSchema.parse(await response.json());

      expect(body.skills).toHaveLength(1);
      expect(body.skills[0]?.namespace).toBe("team");
    });

    it("filters by query", async () => {
      const response = await skillsRoutes.request("/?query=deploy");
      expect(response.status).toBe(200);
      const body = SkillsListSchema.parse(await response.json());

      expect(body.skills.length).toBeGreaterThan(0);
      expect(body.skills.some((s) => s.name === "deploy")).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST VERSIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /@:namespace/:name/versions", () => {
    it("lists all versions of a skill", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review/versions");
      expect(response.status).toBe(200);

      const body = VersionsListSchema.parse(await response.json());
      expect(body.versions).toHaveLength(2);
      // Ordered newest-first (DESC)
      expect(body.versions[0]?.version).toBe(2);
      expect(body.versions[1]?.version).toBe(1);
    });

    it("returns empty list for non-existent skill", async () => {
      const response = await skillsRoutes.request("/@atlas/nonexistent/versions");
      expect(response.status).toBe(200);

      const body = VersionsListSchema.parse(await response.json());
      expect(body.versions).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE VERSION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("DELETE /@:namespace/:name/:version", () => {
    it("deletes a specific version", async () => {
      // Publish a throwaway skill
      await skillsRoutes.request("/@atlas/throwaway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Will be deleted", instructions: "Temporary." }),
      });

      const response = await skillsRoutes.request("/@atlas/throwaway/1", { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true });

      // Verify it's gone
      const getResponse = await skillsRoutes.request("/@atlas/throwaway/1");
      expect(getResponse.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ARCHIVE EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET ...?include=archive", () => {
    it("returns 404 when skill has no archive", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review?include=archive");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("No archive");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

describe("Skills API Routes - Unauthorized Access", () => {
  it("returns 401 for POST without auth", async () => {
    const savedKey = process.env.ATLAS_KEY;
    delete process.env.ATLAS_KEY;

    try {
      const response = await skillsRoutes.request("/@atlas/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Test", instructions: "Test" }),
      });

      expect(response.status).toBe(401);
      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Unauthorized");
    } finally {
      process.env.ATLAS_KEY = savedKey;
    }
  });

  it("returns 401 for DELETE without auth", async () => {
    const savedKey = process.env.ATLAS_KEY;
    delete process.env.ATLAS_KEY;

    try {
      const response = await skillsRoutes.request("/@atlas/test/1", { method: "DELETE" });

      expect(response.status).toBe(401);
      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Unauthorized");
    } finally {
      process.env.ATLAS_KEY = savedKey;
    }
  });
});
