import type {
  CorpusMetadata,
  HistoryEntry,
  MemoryAdapter,
  ScratchpadAdapter,
  ScratchpadChunk,
  SkillAdapter,
  SkillMetadata,
  SkillVersion,
} from "@atlas/agent-sdk";
import { z } from "zod";

export const InspectCommandArgsSchema = z.object({
  workspace: z.string().optional(),
  kind: z.enum(["memory", "skills", "scratchpad"]),
  json: z.boolean().optional(),
  history: z.boolean().optional(),
  since: z.string().optional(),
  session: z.string().optional(),
});

export type InspectCommandArgs = z.infer<typeof InspectCommandArgsSchema>;

export interface InspectDeps {
  memory: MemoryAdapter;
  skills: SkillAdapter;
  scratchpad: ScratchpadAdapter;
}

export interface InspectResult {
  output: string;
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths: number[] = [];
  for (const [i, header] of headers.entries()) {
    let max = header.length;
    for (const row of rows) {
      const cellLen = row[i]?.length ?? 0;
      if (cellLen > max) max = cellLen;
    }
    widths.push(max);
  }

  const lines: string[] = [];

  const headerCells: string[] = [];
  for (const [i, h] of headers.entries()) {
    headerCells.push(h.padEnd(widths[i] ?? 0));
  }
  lines.push(headerCells.join("  "));

  const sepParts: string[] = [];
  for (const w of widths) {
    sepParts.push("\u2500".repeat(w));
  }
  lines.push(sepParts.join("\u2500\u2500"));

  for (const row of rows) {
    const cells: string[] = [];
    for (const [i, cell] of row.entries()) {
      cells.push(cell.padEnd(widths[i] ?? 0));
    }
    lines.push(cells.join("  "));
  }

  return lines.join("\n");
}

async function inspectMemory(deps: InspectDeps, args: InspectCommandArgs): Promise<InspectResult> {
  const workspaceId = args.workspace ?? "default";

  if (args.history) {
    const entries = await deps.memory.history(workspaceId, { since: args.since });
    if (args.json) {
      return { output: JSON.stringify(entries, null, 2) };
    }
    if (entries.length === 0) {
      return { output: "No history entries found." };
    }
    const headers = ["VERSION", "MEMORY", "AT", "SUMMARY"];
    const rows = entries.map((e: HistoryEntry) => [e.version, e.corpus, e.at, e.summary]);
    return { output: formatTable(headers, rows) };
  }

  const memories = await deps.memory.list(workspaceId);
  if (args.json) {
    return { output: JSON.stringify(memories, null, 2) };
  }
  if (memories.length === 0) {
    return { output: "No memories found." };
  }
  const headers = ["NAME", "KIND", "WORKSPACE"];
  const rows = memories.map((c: CorpusMetadata) => [c.name, c.kind, c.workspaceId]);
  return { output: formatTable(headers, rows) };
}

async function inspectSkills(deps: InspectDeps, args: InspectCommandArgs): Promise<InspectResult> {
  const workspaceId = args.workspace ?? "default";

  if (args.history) {
    const skills = await deps.skills.list(workspaceId);
    const allVersions: Array<SkillVersion & { skill: string }> = [];
    for (const skill of skills) {
      const versions = await deps.skills.history(workspaceId, skill.name);
      for (const v of versions) {
        allVersions.push({ ...v, skill: skill.name });
      }
    }
    if (args.json) {
      return { output: JSON.stringify(allVersions, null, 2) };
    }
    if (allVersions.length === 0) {
      return { output: "No skill versions found." };
    }
    const headers = ["SKILL", "VERSION", "CREATED", "SUMMARY"];
    const rows = allVersions.map((v) => [v.skill, v.version, v.createdAt, v.summary]);
    return { output: formatTable(headers, rows) };
  }

  const skills = await deps.skills.list(workspaceId);
  if (args.json) {
    return { output: JSON.stringify(skills, null, 2) };
  }
  if (skills.length === 0) {
    return { output: "No skills found." };
  }
  const headers = ["NAME", "VERSION", "DESCRIPTION"];
  const rows = skills.map((s: SkillMetadata) => [s.name, s.version, s.description]);
  return { output: formatTable(headers, rows) };
}

async function inspectScratchpad(
  deps: InspectDeps,
  args: InspectCommandArgs,
): Promise<InspectResult> {
  const sessionKey = args.session ?? "default";
  const chunks = await deps.scratchpad.read(sessionKey, { since: args.since });

  const sorted = [...chunks].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  if (args.json) {
    return { output: JSON.stringify(sorted, null, 2) };
  }
  if (sorted.length === 0) {
    return { output: "No scratchpad chunks found." };
  }
  const headers = ["ID", "KIND", "CREATED", "BODY"];
  const rows = sorted.map((c: ScratchpadChunk) => [
    c.id,
    c.kind,
    c.createdAt,
    c.body.length > 60 ? `${c.body.slice(0, 57)}...` : c.body,
  ]);
  return { output: formatTable(headers, rows) };
}

export function inspectCommand(
  deps: InspectDeps,
  args: InspectCommandArgs,
): Promise<InspectResult> {
  const parsed = InspectCommandArgsSchema.parse(args);

  switch (parsed.kind) {
    case "memory":
      return inspectMemory(deps, parsed);
    case "skills":
      return inspectSkills(deps, parsed);
    case "scratchpad":
      return inspectScratchpad(deps, parsed);
  }
}
