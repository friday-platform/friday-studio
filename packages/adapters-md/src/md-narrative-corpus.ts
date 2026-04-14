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

  constructor(opts: { workspaceRoot: string }) {
    this.memoryPath = path.join(opts.workspaceRoot, "MEMORY.md");
  }

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    return withSchemaBoundary(
      {
        schema: NarrativeEntrySchema,
        commit: async (parsed: NarrativeEntry): Promise<NarrativeEntry> => {
          const line = `- [${parsed.createdAt}] ${parsed.text} (id: ${parsed.id})\n`;
          await fs.appendFile(this.memoryPath, line, "utf-8");
          return parsed;
        },
      },
      entry,
    );
  }

  read(_opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]> {
    throw new Error("not implemented in skeleton, see Phase 1a follow-up tasks");
  }

  search(_query: string, _opts?: SearchOpts): Promise<NarrativeEntry[]> {
    throw new Error("not implemented in skeleton, see Phase 1a follow-up tasks");
  }

  forget(_id: string): Promise<void> {
    throw new Error("not implemented in skeleton, see Phase 1a follow-up tasks");
  }

  render(): Promise<string> {
    throw new Error("not implemented in skeleton, see Phase 1a follow-up tasks");
  }
}
