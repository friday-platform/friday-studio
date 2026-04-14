/**
 * MdNarrativeCorpus — Markdown-backed NarrativeCorpus implementation.
 *
 * First real backend consumer of withSchemaBoundary. Stores narrative
 * entries as markdown list items in MEMORY.md at the workspace root.
 *
 * From parity plan v6, lines 787-796:
 * > Backend: `md` narrative corpus, root at
 * > `~/.friday/workspaces/<id>/MEMORY.md` + `memory/YYYY-MM-DD.md`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { NarrativeCorpus, NarrativeEntry, SearchOpts } from "@atlas/agent-sdk";
import { NarrativeEntrySchema, withSchemaBoundary } from "@atlas/agent-sdk";

export class MdNarrativeCorpus implements NarrativeCorpus {
  private readonly memoryPath: string;
  private readonly jsonlPath: string;

  constructor(opts: { workspaceRoot: string }) {
    this.memoryPath = path.join(opts.workspaceRoot, "MEMORY.md");
    this.jsonlPath = path.join(opts.workspaceRoot, "entries.jsonl");
  }

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    return withSchemaBoundary(
      {
        schema: NarrativeEntrySchema,
        commit: async (parsed: NarrativeEntry): Promise<NarrativeEntry> => {
          const line = `- [${parsed.createdAt}] ${parsed.text} (id: ${parsed.id})\n`;
          await fs.appendFile(this.memoryPath, line, "utf-8");
          await fs.appendFile(this.jsonlPath, JSON.stringify(parsed) + "\n", "utf-8");
          return parsed;
        },
      },
      entry,
    );
  }

  async read(opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]> {
    let entries: NarrativeEntry[];
    try {
      const raw = await fs.readFile(this.jsonlPath, "utf-8");
      entries = raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parsed: unknown = JSON.parse(line);
          return NarrativeEntrySchema.parse(parsed);
        });
    } catch {
      // JSONL missing — fall back to parsing MEMORY.md
      entries = await this.parseMemoryMd();
    }

    if (opts?.since) {
      const sinceDate = new Date(opts.since);
      entries = entries.filter((e) => new Date(e.createdAt) >= sinceDate);
    }

    if (opts?.limit !== undefined && opts.limit >= 0) {
      entries = entries.slice(0, opts.limit);
    }

    return entries;
  }

  search(_query: string, _opts?: SearchOpts): Promise<NarrativeEntry[]> {
    throw new Error("not implemented in skeleton, see Phase 1a follow-up tasks");
  }

  forget(_id: string): Promise<void> {
    throw new Error("not implemented in skeleton, see Phase 1a follow-up tasks");
  }

  async render(): Promise<string> {
    try {
      return await fs.readFile(this.memoryPath, "utf-8");
    } catch {
      return "";
    }
  }

  private async parseMemoryMd(): Promise<NarrativeEntry[]> {
    let content: string;
    try {
      content = await fs.readFile(this.memoryPath, "utf-8");
    } catch {
      return [];
    }

    const linePattern = /^- \[(.+?)\] (.+?) \(id: (.+?)\)$/;
    const entries: NarrativeEntry[] = [];

    for (const line of content.split("\n")) {
      const match = linePattern.exec(line.trim());
      if (match) {
        const createdAt = match[1] ?? "";
        const text = match[2] ?? "";
        const id = match[3] ?? "";
        entries.push({ id, text, createdAt });
      }
    }

    return entries;
  }
}
