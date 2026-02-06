# User Skills System Design v5

<!-- v5 - 2026-01-12 - Simplified: workspace-only, draft-then-promote flow -->

## Overview

Enable users to capture their expertise (analysis style, domain knowledge, query patterns) as reusable skills that agents automatically discover and apply.

**Primary use case:** Will the analyst wants to democratize his "taste" across his team - distilled from chat transcripts, SQL queries, and other material. Skills are scoped to specific workspaces.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Workspace only | Start simple, add platform scope later if needed |
| Discovery | Workspace-filtered list | Agents see skills for their workspace |
| Loading | Agent-elected | Agents see `<available_skills>`, decide to load based on relevance |
| Storage | Dedicated SkillStorage with workspaceId | Separate from artifacts, workspace binding via foreign key |
| Creation flow | Draft artifact → promote | User reviews before committing, follows workspace-planner pattern |
| Content structure | Flat (instructions only) | Start simple, add references later if needed |
| Agent integration | Unified via agent-context | Same `load_skill` tool for ALL agents (conversation + bundled) |

## Type Definitions

```typescript
// packages/skills/src/types.ts

/** Input for creating a skill (from approved draft) */
export interface CreateSkillInput {
  name: string;           // 1-64 chars, lowercase alphanumeric + hyphens
  description: string;    // 1-1024 chars, what + when to use
  instructions: string;   // Markdown
  workspaceId: string;    // Required
}

/** Stored skill entity */
export interface Skill extends CreateSkillInput {
  id: string;             // ULID
  createdBy: string;      // userId who created it
  createdAt: Date;
  updatedAt: Date;
}

/** Lightweight summary for listing */
export interface SkillSummary {
  name: string;
  description: string;
}
```

## Zod Schemas

```typescript
// packages/skills/src/schemas.ts
import { z } from "zod";

/** Name validation per Agent Skills spec */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Name must be lowercase alphanumeric with single hyphens, no leading/trailing hyphens",
  });

export const CreateSkillInputSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  instructions: z.string().min(1),
  workspaceId: z.string().min(1),
});

export const SkillSchema = CreateSkillInputSchema.extend({
  id: z.string(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const SkillSummarySchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
});
```

## Architecture

### Package Structure

```
packages/skills/
├── src/
│   ├── types.ts          # Skill, CreateSkillInput, SkillSummary
│   ├── schemas.ts        # Zod validation schemas
│   ├── storage.ts        # SkillStorage interface + factory
│   ├── local-adapter.ts  # SQLite adapter (development)
│   ├── format.ts         # formatAvailableSkills helper
│   ├── load-skill-tool.ts # createLoadSkillTool factory
│   └── mod.ts            # Public exports
├── package.json
└── deno.json
```

### Storage Interface

```typescript
// packages/skills/src/storage.ts
import type { Result } from "@atlas/utils";
import type { CreateSkillInput, Skill, SkillSummary } from "./types.ts";

export interface SkillStorageAdapter {
  create(createdBy: string, input: CreateSkillInput): Promise<Result<Skill, string>>;
  update(id: string, input: Partial<CreateSkillInput>): Promise<Result<Skill, string>>;
  get(id: string): Promise<Result<Skill | null, string>>;
  getByName(name: string, workspaceId: string): Promise<Result<Skill | null, string>>;
  list(workspaceId: string): Promise<Result<SkillSummary[], string>>;
  delete(id: string): Promise<Result<void, string>>;
}

// Factory function
export function createSkillStorageAdapter(): SkillStorageAdapter {
  const adapterType = process.env.SKILL_STORAGE_ADAPTER || "local";
  switch (adapterType) {
    case "local":
      return new LocalSkillAdapter();
    default:
      throw new Error(`Unknown skill storage adapter: ${adapterType}`);
  }
}

export const SkillStorage = createSkillStorageAdapter();
```

### Local Storage Adapter

SQLite via `@db/sqlite`. Single database file at `ATLAS_DATA_DIR/skills.db`.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);
```

```typescript
// packages/skills/src/local-adapter.ts
import { Database } from "@db/sqlite";
import { ulid } from "ulid";
import { join } from "@std/path";
import { getAtlasDataDir } from "@atlas/utils/paths.server";
import type { Result } from "@atlas/utils";
import type { CreateSkillInput, Skill, SkillSummary } from "./types.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);
`;

export class LocalSkillAdapter implements SkillStorageAdapter {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(getAtlasDataDir(), "skills.db");
  }

  private getDb(): Database {
    if (!this.db) {
      this.db = new Database(this.dbPath);
      this.db.exec(SCHEMA);
    }
    return this.db;
  }

  async create(createdBy: string, input: CreateSkillInput): Promise<Result<Skill, string>> {
    const db = this.getDb();
    const id = ulid();
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO skills (id, name, description, instructions, workspace_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.name, input.description, input.instructions, input.workspaceId, createdBy, now, now);

      return { ok: true, data: { id, ...input, createdBy, createdAt: new Date(now), updatedAt: new Date(now) } };
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint")) {
        return { ok: false, error: `Skill "${input.name}" already exists in this workspace` };
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async get(id: string): Promise<Result<Skill | null, string>> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    return { ok: true, data: row ? this.rowToSkill(row) : null };
  }

  async getByName(name: string, workspaceId: string): Promise<Result<Skill | null, string>> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM skills WHERE name = ? AND workspace_id = ?").get(name, workspaceId);
    return { ok: true, data: row ? this.rowToSkill(row) : null };
  }

  async list(workspaceId: string): Promise<Result<SkillSummary[], string>> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT name, description FROM skills WHERE workspace_id = ? ORDER BY name
    `).all(workspaceId);
    return { ok: true, data: rows.map(this.rowToSummary) };
  }

  async update(id: string, input: Partial<CreateSkillInput>): Promise<Result<Skill, string>> {
    const db = this.getDb();
    const existing = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    if (!existing) {
      return { ok: false, error: "Skill not found" };
    }

    const now = new Date().toISOString();
    const fields: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
    if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
    if (input.instructions !== undefined) { fields.push("instructions = ?"); values.push(input.instructions); }

    values.push(id);
    db.prepare(`UPDATE skills SET ${fields.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    return { ok: true, data: this.rowToSkill(updated) };
  }

  async delete(id: string): Promise<Result<void, string>> {
    const db = this.getDb();
    db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    return { ok: true, data: undefined };
  }

  private rowToSkill(row: unknown): Skill {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      instructions: r.instructions as string,
      workspaceId: r.workspace_id as string,
      createdBy: r.created_by as string,
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    };
  }

  private rowToSummary(row: unknown): SkillSummary {
    const r = row as Record<string, unknown>;
    return {
      name: r.name as string,
      description: r.description as string,
    };
  }
}
```

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/skills/:workspaceId` | List skills for workspace |
| GET | `/api/skills/:workspaceId/:name` | Get skill by name |
| POST | `/api/skills` | Create skill (workspaceId in body) |
| PATCH | `/api/skills/:id` | Update skill |
| DELETE | `/api/skills/:id` | Remove skill |

```typescript
// apps/atlasd/routes/skills/index.ts
import { Hono } from "hono";
import { SkillStorage } from "@atlas/skills";
import { CreateSkillInputSchema } from "@atlas/skills/schemas";
import { getCurrentUser } from "../me/adapter.ts";

export const skillsRoutes = new Hono()
  .get("/:workspaceId", async (c) => {
    const result = await SkillStorage.list(c.req.param("workspaceId"));
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json(result.data);
  })
  .get("/:workspaceId/:name", async (c) => {
    const result = await SkillStorage.getByName(c.req.param("name"), c.req.param("workspaceId"));
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);
    return c.json(result.data);
  })
  .post("/", async (c) => {
    const userResult = await getCurrentUser();
    if (!userResult.ok || !userResult.data) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const parsed = CreateSkillInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const result = await SkillStorage.create(userResult.data.id, parsed.data);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json(result.data, 201);
  })
  .patch("/:id", async (c) => {
    const result = await SkillStorage.update(c.req.param("id"), await c.req.json());
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json(result.data);
  })
  .delete("/:id", async (c) => {
    const result = await SkillStorage.delete(c.req.param("id"));
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ success: true });
  });
```

## Skill Creation Flow

### 1. skill-distiller Agent

Follows the workspace-planner pattern: does heavy LLM work, saves draft artifact, returns for user review.

```typescript
// packages/system/agents/skill-distiller/skill-distiller.agent.ts
import { createAgent } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { z } from "zod";

const SkillDistillerInputSchema = z.object({
  artifactIds: z.array(z.string()).min(1).describe("Artifact IDs containing corpus material"),
  workspaceId: z.string().describe("Target workspace for the skill"),
  name: z.string().optional().describe("Suggested skill name"),
  focus: z.string().optional().describe("What aspect to emphasize"),
  draftArtifactId: z.string().optional().describe("Existing draft to revise"),
});

type SkillDistillerInput = z.infer<typeof SkillDistillerInputSchema>;

const SYSTEM_PROMPT = `You distill user-provided material into reusable skill definitions.

A skill captures expertise, patterns, and approaches that can be applied to future tasks.

## Output Format

Generate a skill with:
- name: kebab-case identifier (1-64 chars, lowercase alphanumeric + hyphens)
- description: 1-2 sentences explaining what this skill provides and when to use it (max 1024 chars)
- instructions: Detailed markdown that captures the patterns, preferences, and approach

## Guidelines

- Extract the "how" and "why", not just the "what"
- Identify recurring patterns and preferences
- Make instructions actionable - an agent should be able to follow them
- Be specific enough to be useful, general enough to apply broadly`;

export const skillDistillerAgent = createAgent<SkillDistillerInput, Result<...>>({
  id: "skill-distiller",
  displayName: "Skill Distiller",
  version: "1.0.0",
  description: "Distills user material (queries, transcripts, examples) into a reusable skill definition. Returns a draft artifact for review.",
  inputSchema: SkillDistillerInputSchema,

  handler: async (input, { logger, stream, session, abortSignal }) => {
    // 1. Load corpus from artifacts
    const artifactResult = await parseResult(
      client.artifactsStorage.batch.$post({ json: { ids: input.artifactIds } })
    );
    if (!artifactResult.ok) {
      return fail({ reason: `Failed to load artifacts: ${artifactResult.error}` });
    }

    const corpus = artifactResult.data
      .map((a) => `--- ${a.title} ---\n${JSON.stringify(a.data)}`)
      .join("\n\n");

    // 2. Load existing draft if revising
    let existingDraft = null;
    if (input.draftArtifactId) {
      const draftResult = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: input.draftArtifactId } })
      );
      if (draftResult.ok && draftResult.data.artifact.data.type === "skill-draft") {
        existingDraft = draftResult.data.artifact.data.data;
      }
    }

    // 3. Generate/revise skill via LLM
    const prompt = existingDraft
      ? `Revise this skill draft based on feedback:\n${JSON.stringify(existingDraft)}\n\nOriginal corpus:\n${corpus}`
      : `Create a skill from this material:\n${corpus}${input.focus ? `\n\nFocus on: ${input.focus}` : ""}${input.name ? `\n\nSuggested name: ${input.name}` : ""}`;

    const result = await generateObject({
      model: registry.languageModel("anthropic:claude-sonnet-4-5"),
      schema: z.object({
        name: z.string(),
        description: z.string(),
        instructions: z.string(),
      }),
      system: SYSTEM_PROMPT,
      prompt,
      abortSignal,
    });

    const skillDraft = {
      ...result.object,
      workspaceId: input.workspaceId,
    };

    // 4. Save as draft artifact
    if (existingDraft && input.draftArtifactId) {
      const response = await parseResult(
        client.artifactsStorage[":id"].$put({
          param: { id: input.draftArtifactId },
          json: {
            type: "skill-draft",
            data: { type: "skill-draft", version: 1, data: skillDraft },
            summary: `Skill: ${skillDraft.name}`,
            revisionMessage: "Revised based on feedback",
          },
        })
      );
      return success({
        draftArtifactId: response.data.artifact.id,
        revision: response.data.artifact.revision,
        skill: skillDraft,
        nextStep: "Show draft to user. On approval, call create_skill with this draftArtifactId.",
      });
    } else {
      const response = await parseResult(
        client.artifactsStorage.index.$post({
          json: {
            data: { type: "skill-draft", version: 1, data: skillDraft },
            title: `Skill Draft: ${skillDraft.name}`,
            summary: skillDraft.description,
            workspaceId: session.workspaceId,
            chatId: session.streamId,
          },
        })
      );
      return success({
        draftArtifactId: response.data.artifact.id,
        revision: 1,
        skill: skillDraft,
        nextStep: "Show draft to user. On approval, call create_skill with this draftArtifactId.",
      });
    }
  },
});
```

### 2. create_skill Tool

Simple promotion from draft artifact to skill storage.

```typescript
// packages/system/agents/conversation/tools/create-skill.ts
import { tool } from "ai";
import { z } from "zod";
import { client, parseResult } from "@atlas/client/v2";
import { SkillStorage, CreateSkillInputSchema } from "@atlas/skills";

export const createSkillTool = tool({
  name: "create_skill",
  description: "Create a skill from an approved draft artifact. Call after user approves a skill-draft.",
  inputSchema: z.object({
    draftArtifactId: z.string().describe("The skill-draft artifact ID"),
    workspaceId: z.string().describe("Target workspace"),
  }),
  execute: async ({ draftArtifactId, workspaceId }, { session, logger }) => {
    const userId = session.userId;
    if (!userId) {
      return { error: "User authentication required" };
    }

    // 1. Load draft artifact
    const draftResult = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: draftArtifactId } })
    );
    if (!draftResult.ok) {
      return { error: `Failed to load draft: ${draftResult.error}` };
    }
    if (draftResult.data.artifact.data.type !== "skill-draft") {
      return { error: "Artifact is not a skill draft" };
    }

    const draft = draftResult.data.artifact.data.data;

    // 2. Validate and create
    const input = {
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      workspaceId,
    };

    const validated = CreateSkillInputSchema.safeParse(input);
    if (!validated.success) {
      return { error: `Invalid skill: ${validated.error.message}` };
    }

    const result = await SkillStorage.create(userId, validated.data);
    if (!result.ok) {
      return { error: result.error };
    }

    logger.info("skill_created", { skillId: result.data.id, skillName: result.data.name, workspaceId });

    return {
      id: result.data.id,
      name: result.data.name,
      description: result.data.description,
    };
  },
});
```

### 3. Flow Diagram

```
User uploads corpus -> artifacts
    |
    v
User: "Create a skill from these for workspace X"
    |
    v
Conversation agent calls do_task(skill-distiller, {
  artifactIds: ["art_xxx"],
  workspaceId: "ws_xxx"
})
    |
    v
skill-distiller loads corpus, generates skill, saves draft artifact
    |
    v
Returns { draftArtifactId, skill, nextStep }
    |
    v
Conversation agent: "Here's the draft: [shows artifact]. Save it or make changes?"
    |
    v
User: "Save it" -> create_skill({ draftArtifactId, workspaceId })
User: "Change X" -> do_task(skill-distiller, { draftArtifactId, ... })
```

## Skill Loading

### load_skill Tool Factory

```typescript
// packages/skills/src/load-skill-tool.ts
import { logger } from "@atlas/logger";
import type { AtlasTool } from "@atlas/agent-sdk";
import { SkillStorage } from "./storage.ts";

export function createLoadSkillTool(workspaceId: string): AtlasTool {
  return {
    name: "load_skill",
    description: "Load full skill instructions by name. See <available_skills> for options.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name from <available_skills>",
        },
      },
      required: ["name"],
    },
    execute: async ({ name }: { name: string }) => {
      const result = await SkillStorage.getByName(name, workspaceId);

      if (!result.ok) {
        return { error: result.error };
      }
      if (!result.data) {
        return { error: `Skill "${name}" not found. Check <available_skills>.` };
      }

      return {
        name: result.data.name,
        description: result.data.description,
        instructions: result.data.instructions,
      };
    },
  };
}
```

### Format Available Skills

```typescript
// packages/skills/src/format.ts
import type { SkillSummary } from "./types.ts";

export function formatAvailableSkills(skills: SkillSummary[]): string {
  if (!skills.length) return "";

  const entries = skills.map(skill =>
    `<skill name="${skill.name}">${skill.description}</skill>`
  );

  return `<available_skills>
${entries.join("\n")}
</available_skills>`;
}
```

### Agent Context Integration

```typescript
// packages/core/src/agent-context/index.ts - MODIFIED

import { SkillStorage, formatAvailableSkills, createLoadSkillTool } from "@atlas/skills";

return async function buildAgentContext(
  agent: AtlasAgent,
  sessionData: AgentSessionData & { streamId?: string },
  // ...
): Promise<{ context: AgentContext; enrichedPrompt: string }> {

  const workspaceId = sessionData.workspaceId;

  // Fetch skills for this workspace
  const skillsResult = await SkillStorage.list(workspaceId);
  const skills = skillsResult.ok ? skillsResult.data : [];

  // Add load_skill tool if skills exist
  if (skills.length > 0) {
    allTools["load_skill"] = createLoadSkillTool(workspaceId);
  }

  // Enrich prompt with available skills
  let enrichedPrompt = prompt;
  if (skills.length > 0) {
    enrichedPrompt = `${prompt}\n\n${formatAvailableSkills(skills)}`;
  }

  return { context, enrichedPrompt };
};
```

## Artifact Type: skill-draft

```typescript
// packages/core/src/artifacts/types.ts - ADD

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  workspaceId: string;
}

export interface SkillDraftArtifact {
  type: "skill-draft";
  version: 1;
  data: SkillDraft;
}
```

## Implementation Order

1. **`packages/skills/`** - Types, schemas, storage interface, local adapter
2. **Artifact type** - Add `skill-draft` to artifact types
3. **API routes** - `/api/skills/:workspaceId`
4. **`skill-distiller` agent** - Following workspace-planner pattern
5. **`create_skill` tool** - Simple draft promotion
6. **Agent context integration** - Inject `load_skill` + `<available_skills>`

## Success Criteria

### Unit Tests

- [ ] `SkillNameSchema` validates spec-compliant names, rejects invalid
- [ ] `formatAvailableSkills` generates correct XML
- [ ] Storage adapter CRUD operations work correctly
- [ ] `createLoadSkillTool` finds skills by name

### Integration Tests

- [ ] `skill-distiller` creates draft artifact from corpus
- [ ] `create_skill` promotes draft to skill storage
- [ ] `load_skill` returns skill instructions
- [ ] Skills from other workspaces are not visible

### E2E Validation

- [ ] User can create skill via distiller flow
- [ ] User can revise draft before saving
- [ ] Agents see skills in `<available_skills>`
- [ ] Agents can load and apply skill instructions

## Migration: Existing Conversation Agent Skills

The conversation agent currently has hardcoded skills in `packages/system/agents/conversation/skills/`. These coexist:

1. **Phase 1:** User skills via new system, hardcoded skills remain
2. **Phase 2:** Migrate hardcoded skills to workspace storage (optional)

For Phase 1, the conversation agent's existing `load_skill` checks hardcoded first:

```typescript
execute: async ({ id }) => {
  // 1. Check hardcoded skills
  const hardcoded = hardcodedSkills.find((s) => s.id === id);
  if (hardcoded) {
    return { skill: id, instructions: hardcoded.instructions };
  }

  // 2. Delegate to workspace-scoped load_skill
  return createLoadSkillTool(workspaceId).execute({ name: id });
}
```

## Changes from v4

| Component | v4 | v5 |
|-----------|----|----|
| Scope | Workspace + platform | Workspace only |
| `Skill` fields | Included license, compatibility, metadata | Removed |
| Token budget | MAX_SKILLS_IN_PROMPT, truncation | Removed |
| `create_skill` | LLM distillation inline | Simple draft promotion |
| Creation flow | Single tool | skill-distiller agent + create_skill tool |
| `<available_skills>` | Included id attribute | Name only |
| `list()` | Options object with nullable workspaceId | Required workspaceId string |
| `listByWorkspace()` | Separate method | Removed (merged into list) |

## Future Considerations

- **Platform-level skills** - Add back when org-wide sharing is needed
- **Skill versioning** - Track changes, allow rollback
- **Skill categories/tags** - Filter skills by domain
- **Usage analytics** - Track which skills are loaded most often
