/**
 * MdSkillAdapter — Markdown-backed SkillAdapter implementation.
 *
 * Storage layout: {root}/skills/{workspaceId}/{name}/draft.md
 * with YAML frontmatter (name/description/version) + instructions
 * as markdown body.
 *
 * From parity plan v6, lines 673-686:
 * > SkillAdapter — versioned, validated, hot-reloadable
 *
 * The `md` backend uses `.history/` snapshot dirs for versioning,
 * but history/rollback are deferred to Phase 1b.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ResolvedSkill,
  SkillAdapter,
  SkillDraft,
  SkillMetadata,
  SkillVersion,
} from "@atlas/agent-sdk";
import { SkillDraftSchema, withSchemaBoundary } from "@atlas/agent-sdk";

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}

interface DraftFrontmatter {
  name: string;
  description: string;
  version: string;
}

function parseDraftMd(content: string): {
  name: string;
  description: string;
  version: string;
  instructions: string;
} {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    throw new Error("Invalid draft.md: missing opening frontmatter delimiter");
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error("Invalid draft.md: missing closing frontmatter delimiter");
  }

  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }

  const instructions = lines
    .slice(closingIndex + 1)
    .join("\n")
    .trimStart();

  return {
    name: meta["name"] ?? "",
    description: meta["description"] ?? "",
    version: meta["version"] ?? "1",
    instructions,
  };
}

function serializeDraftMd(meta: DraftFrontmatter, instructions: string): string {
  return `---\nname: ${meta.name}\ndescription: ${meta.description}\nversion: "${meta.version}"\n---\n${instructions}`;
}

export class MdSkillAdapter implements SkillAdapter {
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  private skillsDir(workspaceId: string): string {
    return path.join(this.root, "skills", workspaceId);
  }

  private draftPath(workspaceId: string, name: string): string {
    return path.join(this.skillsDir(workspaceId), name, "draft.md");
  }

  async list(workspaceId: string, _agentId?: string): Promise<SkillMetadata[]> {
    const dir = this.skillsDir(workspaceId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }

    const results: SkillMetadata[] = [];
    for (const entry of entries) {
      const draftFile = path.join(dir, entry, "draft.md");
      try {
        const content = await fs.readFile(draftFile, "utf-8");
        const parsed = parseDraftMd(content);
        results.push({
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
        });
      } catch {
        // Skip entries without valid draft.md
      }
    }
    return results;
  }

  async get(workspaceId: string, name: string): Promise<ResolvedSkill | undefined> {
    const filePath = this.draftPath(workspaceId, name);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      return undefined;
    }

    const parsed = parseDraftMd(content);
    return {
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      version: parsed.version,
    };
  }

  create(workspaceId: string, draft: SkillDraft): Promise<ResolvedSkill> {
    return withSchemaBoundary(
      {
        schema: SkillDraftSchema,
        commit: async (parsed: SkillDraft): Promise<ResolvedSkill> => {
          const filePath = this.draftPath(workspaceId, parsed.name);
          await fs.mkdir(path.dirname(filePath), { recursive: true });

          const meta: DraftFrontmatter = {
            name: parsed.name,
            description: parsed.description,
            version: "1",
          };
          await fs.writeFile(filePath, serializeDraftMd(meta, parsed.instructions), "utf-8");

          return {
            name: parsed.name,
            description: parsed.description,
            instructions: parsed.instructions,
            version: "1",
          };
        },
      },
      draft,
    );
  }

  update(workspaceId: string, name: string, patch: Partial<SkillDraft>): Promise<ResolvedSkill> {
    return withSchemaBoundary(
      {
        schema: SkillDraftSchema.partial(),
        commit: async (validatedPatch: Partial<SkillDraft>): Promise<ResolvedSkill> => {
          const filePath = this.draftPath(workspaceId, name);
          const content = await fs.readFile(filePath, "utf-8");
          const existing = parseDraftMd(content);

          const merged = {
            name: validatedPatch.name ?? existing.name,
            description: validatedPatch.description ?? existing.description,
            instructions: validatedPatch.instructions ?? existing.instructions,
          };

          const newVersion = String(parseInt(existing.version, 10) + 1);

          const meta: DraftFrontmatter = {
            name: merged.name,
            description: merged.description,
            version: newVersion,
          };
          await fs.writeFile(filePath, serializeDraftMd(meta, merged.instructions), "utf-8");

          return {
            name: merged.name,
            description: merged.description,
            instructions: merged.instructions,
            version: newVersion,
          };
        },
      },
      patch,
    );
  }

  history(_workspaceId: string, _name: string): Promise<SkillVersion[]> {
    throw new NotImplementedError(
      "history() requires versioning backend — out of scope for md adapter, see Phase 1b",
    );
  }

  rollback(_workspaceId: string, _name: string, _toVersion: string): Promise<ResolvedSkill> {
    throw new NotImplementedError(
      "rollback() requires versioning backend — out of scope for md adapter, see Phase 1b",
    );
  }

  invalidate(_workspaceId: string): void {
    // No-op — cache wiring is for a later task
  }
}
