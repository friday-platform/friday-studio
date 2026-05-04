import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { initSkillStorage } from "@atlas/skills";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

// Set up isolated test environment BEFORE importing routes
const testDir = join(tmpdir(), `skills-routes-test-${Date.now()}`);
mkdirSync(join(testDir, "data"), { recursive: true });
process.env.FRIDAY_HOME = testDir;

// Create a test JWT for auth
function createTestJwt(payload: Record<string, unknown>): string {
  const header = { alg: "none", typ: "JWT" };
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode(header)}.${encode(payload)}.`;
}

// Tests publish into the @friday namespace, which is gated to the
// bootstrap-loader sentinel id "system" via isFridayNamespaceBlockedForUser.
// Use that id here so the publish path isn't 403'd out.
process.env.FRIDAY_KEY = createTestJwt({
  email: "test@example.com",
  sub: "system",
  user_metadata: { tempest_user_id: "system" },
});

process.env.USER_IDENTITY_ADAPTER = "local";

const { skillsRoutes } = await import("./skills.ts");

// Response schemas
const SkillResponseSchema = z.object({
  skill: z.object({
    id: z.string(),
    skillId: z.string(),
    namespace: z.string(),
    name: z.string().nullable(),
    version: z.number(),
    description: z.string(),
    descriptionManual: z.boolean(),
    disabled: z.boolean(),
    instructions: z.string(),
    frontmatter: z.record(z.string(), z.unknown()),
    createdBy: z.string(),
    createdAt: z.coerce.date(),
  }),
});

const PublishedResponseSchema = z.object({
  published: z.object({
    id: z.string(),
    skillId: z.string(),
    namespace: z.string(),
    name: z.string(),
    version: z.number(),
  }),
});

const SkillsListSchema = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      skillId: z.string(),
      namespace: z.string(),
      name: z.string().nullable(),
      description: z.string(),
      disabled: z.boolean(),
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

let natsServer: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  natsServer = await startNatsTestServer();
  nc = await connect({ servers: natsServer.url });
  initSkillStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await natsServer.stop();
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
          descriptionManual: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published).toMatchObject({ namespace: "atlas", name: "code-review", version: 1 });
    });

    it("splits embedded frontmatter into the frontmatter column on JSON publish", async () => {
      const fullSkillMd =
        "---\nname: split-me\ndescription: This is a test skill description.\n---\n\n# Split Me\n\nBody content.\n";
      const publishRes = await skillsRoutes.request("/@atlas/split-me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: fullSkillMd }),
      });
      expect(publishRes.status).toBe(201);

      const getRes = await skillsRoutes.request("/@atlas/split-me");
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as {
        skill: { instructions: string; frontmatter: Record<string, unknown>; description: string };
      };
      expect(body.skill.frontmatter).toMatchObject({
        name: "split-me",
        description: "This is a test skill description.",
      });
      expect(body.skill.instructions).not.toContain("---");
      expect(body.skill.instructions).toContain("# Split Me");
    });

    it("auto-increments version on subsequent publish", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "Reviews code v2",
          instructions: "Review the code more carefully.",
          descriptionManual: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published.version).toBe(2);
    });

    it("allows publish without description", async () => {
      const response = await skillsRoutes.request("/@atlas/no-desc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: "Do stuff" }),
      });

      expect(response.status).toBe(201);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT (self-contained tar.gz with reconstructed SKILL.md)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /:namespace/:name/export", () => {
    it("exports a published skill as a tar.gz containing SKILL.md", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review/export");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/gzip");
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).toContain('filename="@atlas-code-review-v');
      expect(disposition).toContain('.tar.gz"');

      const { extractArchiveContents } = await import("@atlas/skills/archive");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contents = await extractArchiveContents(bytes);
      expect(contents["SKILL.md"]).toBeDefined();
      expect(contents["SKILL.md"]).toContain("Review the code more carefully.");
    });

    it("returns 404 for non-existent skill", async () => {
      const response = await skillsRoutes.request("/@atlas/nonexistent/export");
      expect(response.status).toBe(404);
      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // IMPORT (round-trip from exported tar.gz)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /import-archive", () => {
    it("imports a previously-exported tar.gz and republishes the skill", async () => {
      const { packExportArchive } = await import("@atlas/skills/archive");
      const frontmatter = {
        name: "@atlas/imported-skill",
        description: "Imported skill for round-trip test. Use when testing import.",
      };
      const instructions = "# Imported\n\nDo the thing.";
      const archiveBytes = await packExportArchive({ instructions, frontmatter, archive: null });

      const formData = new FormData();
      formData.append(
        "archive",
        new File([new Uint8Array(archiveBytes)], "imported.tar.gz", { type: "application/gzip" }),
      );

      const response = await skillsRoutes.request("/import-archive", {
        method: "POST",
        body: formData,
      });
      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published.namespace).toBe("atlas");
      expect(body.published.name).toBe("imported-skill");

      // Verify the skill is fetchable + content survived the round trip
      const getRes = await skillsRoutes.request("/@atlas/imported-skill");
      expect(getRes.status).toBe(200);
      const skill = SkillResponseSchema.parse(await getRes.json());
      expect(skill.skill.description).toBe(frontmatter.description);
      expect(skill.skill.instructions).toBe(instructions);
    });

    it("returns 400 with needsNamespace when frontmatter has no namespace", async () => {
      const { packExportArchive } = await import("@atlas/skills/archive");
      const archiveBytes = await packExportArchive({
        instructions: "Body of skill.",
        frontmatter: {
          name: "just-a-name",
          description: "Skill without namespace. Use when something happens.",
        },
        archive: null,
      });

      const formData = new FormData();
      formData.append(
        "archive",
        new File([new Uint8Array(archiveBytes)], "imported.tar.gz", { type: "application/gzip" }),
      );

      const response = await skillsRoutes.request("/import-archive", {
        method: "POST",
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = z
        .object({ error: z.string(), needsNamespace: z.literal(true), defaultName: z.string() })
        .parse(await response.json());
      expect(body.needsNamespace).toBe(true);
      expect(body.defaultName).toBe("just-a-name");
    });

    it("uses ?namespace= query param to supply a missing namespace", async () => {
      const { packExportArchive } = await import("@atlas/skills/archive");
      const archiveBytes = await packExportArchive({
        instructions: "Body of skill.",
        frontmatter: {
          name: "just-a-name",
          description: "Skill without namespace. Use when something happens.",
        },
        archive: null,
      });

      const formData = new FormData();
      formData.append(
        "archive",
        new File([new Uint8Array(archiveBytes)], "imported.tar.gz", { type: "application/gzip" }),
      );

      const response = await skillsRoutes.request("/import-archive?namespace=eric", {
        method: "POST",
        body: formData,
      });
      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published.namespace).toBe("eric");
      expect(body.published.name).toBe("just-a-name");

      const getRes = await skillsRoutes.request("/@eric/just-a-name");
      expect(getRes.status).toBe(200);
    });

    it("returns 400 when SKILL.md has malformed frontmatter", async () => {
      const { packSkillArchive } = await import("@atlas/skills/archive");
      const tmpDir = join(testDir, `malformed-import-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      try {
        writeFileSync(join(tmpDir, "SKILL.md"), "---\nname: [unclosed\n---\n\nBody.\n");
        const archiveBytes = await packSkillArchive(tmpDir);

        const formData = new FormData();
        formData.append(
          "archive",
          new File([new Uint8Array(archiveBytes)], "bad.tar.gz", { type: "application/gzip" }),
        );

        const response = await skillsRoutes.request("/import-archive", {
          method: "POST",
          body: formData,
        });
        expect(response.status).toBe(400);
        const body = ErrorSchema.parse(await response.json());
        expect(body.error).toContain("SKILL.md parse failed");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns 400 with deadLinks when instructions reference missing files", async () => {
      const { packExportArchive } = await import("@atlas/skills/archive");
      const archiveBytes = await packExportArchive({
        instructions: "# Skill\n\nUses [missing](references/missing.md).\n",
        frontmatter: {
          name: "@atlas/dead-links",
          description: "Skill with dead links. Use when testing dead link validation.",
        },
        archive: null,
      });

      const formData = new FormData();
      formData.append(
        "archive",
        new File([new Uint8Array(archiveBytes)], "dead-links.tar.gz", { type: "application/gzip" }),
      );

      const response = await skillsRoutes.request("/import-archive", {
        method: "POST",
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = z
        .object({ error: z.string(), deadLinks: z.array(z.string()) })
        .parse(await response.json());
      expect(body.deadLinks).toContain("references/missing.md");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE BLANK SKILL
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST / (create blank skill)", () => {
    it("creates a blank skill and returns skillId", async () => {
      const response = await skillsRoutes.request("/", { method: "POST" });
      expect(response.status).toBe(201);

      const body = z.object({ skillId: z.string() }).parse(await response.json());
      expect(body.skillId).toBeTruthy();
    });

    it("returns 401 without auth", async () => {
      const savedKey = process.env.FRIDAY_KEY;
      delete process.env.FRIDAY_KEY;

      try {
        const response = await skillsRoutes.request("/", { method: "POST" });
        expect(response.status).toBe(401);
        const body = ErrorSchema.parse(await response.json());
        expect(body.error).toBe("Unauthorized");
      } finally {
        process.env.FRIDAY_KEY = savedKey;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET BY SKILL ID
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /:skillId (get by skillId)", () => {
    it("returns latest version by skillId", async () => {
      // Create a blank skill, then publish to give it a name
      const createRes = await skillsRoutes.request("/", { method: "POST" });
      const { skillId } = z.object({ skillId: z.string() }).parse(await createRes.json());

      await skillsRoutes.request("/@friday/by-id-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId,
          description: "Test skill for getBySkillId",
          instructions: "Test instructions.",
          descriptionManual: true,
        }),
      });

      const response = await skillsRoutes.request(`/${skillId}`);
      expect(response.status).toBe(200);

      const body = SkillResponseSchema.parse(await response.json());
      expect(body.skill).toMatchObject({
        skillId,
        namespace: "friday",
        name: "by-id-test",
        description: "Test skill for getBySkillId",
      });
    });

    it("returns 404 for non-existent skillId", async () => {
      const response = await skillsRoutes.request("/01NONEXISTENT0000000000000");
      expect(response.status).toBe(404);
      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });

    it("does not include archive blob", async () => {
      // Use a skill we know exists from earlier tests
      const createRes = await skillsRoutes.request("/", { method: "POST" });
      const { skillId } = z.object({ skillId: z.string() }).parse(await createRes.json());

      const response = await skillsRoutes.request(`/${skillId}`);
      expect(response.status).toBe(200);
      const json = (await response.json()) as { skill: Record<string, unknown> };
      expect(json.skill).not.toHaveProperty("archive");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST FILTERING (includeAll)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET / (list filtering)", () => {
    it("excludes unnamed skills by default", async () => {
      // Create a blank skill (unnamed)
      await skillsRoutes.request("/", { method: "POST" });

      const response = await skillsRoutes.request("/");
      expect(response.status).toBe(200);
      const body = SkillsListSchema.parse(await response.json());

      // All returned skills should have a name
      for (const skill of body.skills) {
        expect(skill.name).not.toBeNull();
      }
    });

    it("includes unnamed skills when includeAll=true", async () => {
      const response = await skillsRoutes.request("/?includeAll=true");
      expect(response.status).toBe(200);
      const body = SkillsListSchema.parse(await response.json());

      // Should include at least one unnamed skill from create above
      const unnamed = body.skills.filter((s) => s.name === null);
      expect(unnamed.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLISH WITH SKILL ID LINKAGE
  // ═══════════════════════════════════════════════════════════════════════════

  describe("publish with skillId linkage", () => {
    it("returns skillId in publish response", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "Reviews code v3",
          instructions: "Review the code even more carefully.",
        }),
      });

      expect(response.status).toBe(201);
      const body = PublishedResponseSchema.parse(await response.json());
      expect(body.published.skillId).toBeTruthy();
    });

    it("links to existing skill when skillId provided", async () => {
      // Create a blank skill
      const createRes = await skillsRoutes.request("/", { method: "POST" });
      const { skillId } = z.object({ skillId: z.string() }).parse(await createRes.json());

      // Publish with that skillId
      const pubRes = await skillsRoutes.request("/@friday/linked-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId,
          description: "Linked to existing",
          instructions: "Test linkage.",
          descriptionManual: true,
        }),
      });

      expect(pubRes.status).toBe(201);
      const pubBody = PublishedResponseSchema.parse(await pubRes.json());
      expect(pubBody.published.skillId).toBe(skillId);

      // Verify fetching by skillId returns the published version
      const getRes = await skillsRoutes.request(`/${skillId}`);
      expect(getRes.status).toBe(200);
      const getBody = SkillResponseSchema.parse(await getRes.json());
      expect(getBody.skill).toMatchObject({
        skillId,
        name: "linked-skill",
        description: "Linked to existing",
      });
    });

    it("renames all versions when publishing with skillId and new name", async () => {
      // Create a blank skill (inserts version 1 as draft), then publish with a name
      const createRes = await skillsRoutes.request("/", { method: "POST" });
      const { skillId } = z.object({ skillId: z.string() }).parse(await createRes.json());

      await skillsRoutes.request("/@friday/old-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId,
          description: "Original name",
          instructions: "Test rename v1.",
        }),
      });

      // Publish again with same skillId but different name
      await skillsRoutes.request("/@friday/new-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId,
          description: "Renamed skill",
          instructions: "Test rename v2.",
        }),
      });

      // All versions (draft + 2 publishes) should now have the new name
      const versionsRes = await skillsRoutes.request("/@friday/new-name/versions");
      expect(versionsRes.status).toBe(200);
      const versionsBody = z
        .object({ versions: z.array(z.object({ version: z.number() })) })
        .parse(await versionsRes.json());
      expect(versionsBody.versions).toHaveLength(3);

      // Old name should no longer resolve
      const oldNameRes = await skillsRoutes.request("/@friday/old-name");
      expect(oldNameRes.status).toBe(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHIVE FILE LISTING & CONTENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Skills API Routes - Archive Files", () => {
  /**
   * Publishes a skill with a real tarball archive containing the given files.
   * Uses the multipart upload endpoint so the archive is stored.
   */
  async function publishWithArchive(
    namespace: string,
    name: string,
    files: Record<string, string>,
  ): Promise<void> {
    const { packSkillArchive } = await import("@atlas/skills/archive");
    const archiveDir = join(tmpdir(), `skills-test-archive-${Date.now()}`);
    mkdirSync(archiveDir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(archiveDir, filePath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
    }

    const archiveBuffer = await packSkillArchive(archiveDir);
    rmSync(archiveDir, { recursive: true, force: true });

    const formData = new FormData();
    formData.append(
      "archive",
      new File([new Uint8Array(archiveBuffer)], "skill.tar.gz", { type: "application/gzip" }),
    );
    formData.append("description", "Skill with archive");
    formData.append("instructions", "Test instructions.");

    const response = await skillsRoutes.request(`/@${namespace}/${name}/upload`, {
      method: "POST",
      body: formData,
    });
    expect(response.status).toBe(201);
  }

  // ─── LIST FILES ──────────────────────────────────────────────────────────────

  describe("GET /@:namespace/:name/files (list archive files)", () => {
    it("returns file paths for skill with archive", async () => {
      await publishWithArchive("atlas", "with-archive", {
        "references/foo.md": "# Foo\nSome content.",
        "references/bar.md": "# Bar\nOther content.",
        "data/schema.json": '{"type": "object"}',
      });

      const response = await skillsRoutes.request("/@atlas/with-archive/files");
      expect(response.status).toBe(200);

      const body = z.object({ files: z.array(z.string()) }).parse(await response.json());
      expect(body.files).toContain("references/foo.md");
      expect(body.files).toContain("references/bar.md");
      expect(body.files).toContain("data/schema.json");
    });

    it("returns empty array for skill without archive", async () => {
      // code-review was published via JSON (no archive)
      const response = await skillsRoutes.request("/@atlas/code-review/files");
      expect(response.status).toBe(200);

      const body = z.object({ files: z.array(z.string()) }).parse(await response.json());
      expect(body.files).toHaveLength(0);
    });

    it("returns 404 for nonexistent skill", async () => {
      const response = await skillsRoutes.request("/@atlas/nonexistent-archive/files");
      expect(response.status).toBe(404);

      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });
  });

  // ─── GET FILE CONTENT ────────────────────────────────────────────────────────

  describe("GET /@:namespace/:name/files/* (archive file content)", () => {
    it("returns file content from archive", async () => {
      const response = await skillsRoutes.request("/@atlas/with-archive/files/references/foo.md");
      expect(response.status).toBe(200);

      const body = z.object({ path: z.string(), content: z.string() }).parse(await response.json());
      expect(body.path).toBe("references/foo.md");
      expect(body.content).toContain("# Foo");
    });

    it("returns 404 for nonexistent file in archive", async () => {
      const response = await skillsRoutes.request("/@atlas/with-archive/files/nonexistent.md");
      expect(response.status).toBe(404);

      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("File not found in archive");
    });

    it("rejects path traversal attempt", async () => {
      // URL normalization resolves /../ before it reaches the handler,
      // so the path becomes /@atlas/with-archive/etc/passwd which doesn't
      // match the /files/* route. Verify with an encoded traversal that
      // bypasses URL normalization but is caught by the handler's guard.
      const req = new Request("http://localhost/@atlas/with-archive/files/..%2Fetc%2Fpasswd");
      const response = await skillsRoutes.request(req);
      // Either 400 (handler catches ..) or route doesn't match — both prevent traversal
      expect(response.status).not.toBe(200);
    });

    it("returns 404 for nonexistent skill", async () => {
      const response = await skillsRoutes.request("/@atlas/nonexistent-archive/files/any.md");
      expect(response.status).toBe(404);

      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });

    it("returns 404 when skill has no archive", async () => {
      const response = await skillsRoutes.request("/@atlas/code-review/files/any.md");
      expect(response.status).toBe(404);

      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("No archive available");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

describe("Skills API Routes - Unauthorized Access", () => {
  it("returns 401 for POST without auth", async () => {
    const savedKey = process.env.FRIDAY_KEY;
    delete process.env.FRIDAY_KEY;

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
      process.env.FRIDAY_KEY = savedKey;
    }
  });

  it("returns 401 for DELETE without auth", async () => {
    const savedKey = process.env.FRIDAY_KEY;
    delete process.env.FRIDAY_KEY;

    try {
      const response = await skillsRoutes.request("/@atlas/test/1", { method: "DELETE" });

      expect(response.status).toBe(401);
      const body = ErrorSchema.parse(await response.json());
      expect(body.error).toBe("Unauthorized");
    } finally {
      process.env.FRIDAY_KEY = savedKey;
    }
  });
});
