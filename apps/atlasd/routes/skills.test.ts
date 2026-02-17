import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

// Set up isolated test environment BEFORE importing routes
// This ensures SkillStorage uses a test-only database
const testDir = join(tmpdir(), `skills-routes-test-${Date.now()}`);
mkdirSync(join(testDir, "data"), { recursive: true });
process.env.ATLAS_HOME = testDir;

// Create a test JWT that getCurrentUser can decode
// Format: header.payload.signature (we only need the payload to be decodable)
function createTestJwt(payload: Record<string, unknown>): string {
  const header = { alg: "none", typ: "JWT" };
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode(header)}.${encode(payload)}.`;
}

// Set test user JWT
process.env.ATLAS_KEY = createTestJwt({
  email: "test@example.com",
  sub: "test-user-id",
  user_metadata: { tempest_user_id: "test-tempest-id" },
});

// Force local adapter (skip persona service)
process.env.USER_IDENTITY_ADAPTER = "local";

// Now import the routes after env is configured
const { skillsRoutes } = await import("./skills.ts");

/** Schema for skill response */
const SkillResponseSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    workspaceId: z.string(),
    createdBy: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  }),
});

/** Schema for skills list response */
const SkillsListSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
});

/** Schema for error response */
const ErrorResponseSchema = z.object({ error: z.string() });

describe("Skills API Routes", () => {
  const workspaceId = "test-workspace";
  let createdSkillId: string;

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("GET /:workspaceId", () => {
    it("returns empty skills list for new workspace", async () => {
      const response = await skillsRoutes.request(`/${workspaceId}`);
      expect(response.status).toBe(200);

      const body = SkillsListSchema.parse(await response.json());
      expect(body.skills).toEqual([]);
    });
  });

  describe("POST /", () => {
    it("creates a new skill", async () => {
      const input = {
        name: "test-skill",
        description: "A test skill for integration tests",
        instructions: "Follow these test instructions",
        workspaceId,
      };

      const response = await skillsRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(response.status).toBe(201);
      const body = SkillResponseSchema.parse(await response.json());

      expect(body.skill.id).toBeDefined();
      expect(body.skill.name).toBe(input.name);
      expect(body.skill.description).toBe(input.description);
      expect(body.skill.instructions).toBe(input.instructions);
      expect(body.skill.workspaceId).toBe(input.workspaceId);
      expect(body.skill.createdBy).toBe("test-tempest-id");

      createdSkillId = body.skill.id;
    });

    it("rejects duplicate skill name in same workspace", async () => {
      const input = {
        name: "test-skill", // Same name as above
        description: "Another description",
        instructions: "Different instructions",
        workspaceId,
      };

      const response = await skillsRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(response.status).toBe(400);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error.includes("already exists")).toBe(true);
    });

    it("allows same skill name in different workspace", async () => {
      const input = {
        name: "test-skill", // Same name, different workspace
        description: "Skill in another workspace",
        instructions: "Instructions for other workspace",
        workspaceId: "other-workspace",
      };

      const response = await skillsRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(response.status).toBe(201);
      const body = SkillResponseSchema.parse(await response.json());
      expect(body.skill.workspaceId).toBe("other-workspace");
    });

    it("validates skill name format", async () => {
      const input = {
        name: "Invalid Name!", // Invalid: uppercase, spaces, special chars
        description: "Test",
        instructions: "Test",
        workspaceId,
      };

      const response = await skillsRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(response.status).toBe(400);
    });

    it("requires description", async () => {
      const input = { name: "no-desc-skill", instructions: "Test", workspaceId };

      const response = await skillsRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("GET /:workspaceId/:name", () => {
    it("returns skill by name", async () => {
      const response = await skillsRoutes.request(`/${workspaceId}/test-skill`);

      expect(response.status).toBe(200);
      const body = SkillResponseSchema.parse(await response.json());

      expect(body.skill.name).toBe("test-skill");
      expect(body.skill.workspaceId).toBe(workspaceId);
    });

    it("returns 404 for non-existent skill", async () => {
      const response = await skillsRoutes.request(`/${workspaceId}/non-existent`);

      expect(response.status).toBe(404);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });
  });

  describe("GET /:workspaceId (after creating skills)", () => {
    it("returns skills list with created skill", async () => {
      const response = await skillsRoutes.request(`/${workspaceId}`);

      expect(response.status).toBe(200);
      const body = SkillsListSchema.parse(await response.json());

      expect(body.skills.length).toBe(1);
      expect(body.skills[0]?.name).toBe("test-skill");
      expect(body.skills[0]?.description).toBe("A test skill for integration tests");
    });
  });

  describe("PATCH /:id", () => {
    it("updates skill description", async () => {
      const response = await skillsRoutes.request(`/${createdSkillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated description" }),
      });

      expect(response.status).toBe(200);
      const body = SkillResponseSchema.parse(await response.json());
      expect(body.skill.description).toBe("Updated description");
      expect(body.skill.name).toBe("test-skill"); // unchanged
      expect(body.skill.instructions).toBe("Follow these test instructions"); // unchanged
    });

    it("updates multiple fields", async () => {
      const response = await skillsRoutes.request(`/${createdSkillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "Fully updated description",
          instructions: "New instructions",
        }),
      });

      expect(response.status).toBe(200);
      const body = SkillResponseSchema.parse(await response.json());
      expect(body.skill.description).toBe("Fully updated description");
      expect(body.skill.instructions).toBe("New instructions");
    });

    it("returns 404 for non-existent skill", async () => {
      const response = await skillsRoutes.request("/non-existent-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Test" }),
      });

      expect(response.status).toBe(404);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });

    it("validates skill name format on update", async () => {
      const response = await skillsRoutes.request(`/${createdSkillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Invalid Name!" }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("DELETE /:id", () => {
    it("deletes skill by id", async () => {
      const response = await skillsRoutes.request(`/${createdSkillId}`, { method: "DELETE" });

      expect(response.status).toBe(200);
      const body = z.object({ success: z.literal(true) }).parse(await response.json());
      expect(body.success).toBe(true);

      // Verify skill is gone
      const getResponse = await skillsRoutes.request(`/${workspaceId}/test-skill`);
      expect(getResponse.status).toBe(404);
    });

    it("returns 404 for non-existent id", async () => {
      const response = await skillsRoutes.request("/non-existent-id", { method: "DELETE" });

      expect(response.status).toBe(404);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error).toBe("Skill not found");
    });
  });
});

// Separate describe block to test unauthorized access without ATLAS_KEY
describe("Skills API Routes - Unauthorized Access", () => {
  it("returns 401 for POST without auth", async () => {
    // Clear ATLAS_KEY to simulate unauthorized access
    const savedKey = process.env.ATLAS_KEY;
    delete process.env.ATLAS_KEY;

    try {
      const response = await skillsRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "unauth-skill",
          description: "Test",
          instructions: "Test",
          workspaceId: "test",
        }),
      });

      expect(response.status).toBe(401);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error).toBe("Unauthorized");
    } finally {
      process.env.ATLAS_KEY = savedKey;
    }
  });

  it("returns 401 for PATCH without auth", async () => {
    const savedKey = process.env.ATLAS_KEY;
    delete process.env.ATLAS_KEY;

    try {
      const response = await skillsRoutes.request("/some-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated" }),
      });

      expect(response.status).toBe(401);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error).toBe("Unauthorized");
    } finally {
      process.env.ATLAS_KEY = savedKey;
    }
  });

  it("returns 401 for DELETE without auth", async () => {
    const savedKey = process.env.ATLAS_KEY;
    delete process.env.ATLAS_KEY;

    try {
      const response = await skillsRoutes.request("/some-id", { method: "DELETE" });

      expect(response.status).toBe(401);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error).toBe("Unauthorized");
    } finally {
      process.env.ATLAS_KEY = savedKey;
    }
  });
});
