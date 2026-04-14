export interface DiffStats {
  additions: number;
  deletions: number;
}

export function computeUnifiedDiff(
  before: string,
  after: string,
  filename = "workspace.yml",
): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const hunks = buildHunks(beforeLines, afterLines);
  if (hunks.length === 0) return "";

  const header = `--- a/${filename}\n+++ b/${filename}`;
  const hunkText = hunks.map(formatHunk).join("\n");
  return `${header}\n${hunkText}`;
}

export function parseDiffStats(diff: string): DiffStats {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return { additions, deletions };
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function buildHunks(before: string[], after: string[]): Hunk[] {
  const edits = computeEdits(before, after);

  if (edits.every((e) => e.type === "equal")) return [];

  const CONTEXT = 3;
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let trailingSince = -1;

  for (const [idx, edit] of edits.entries()) {
    if (edit.type === "equal") {
      if (currentHunk) {
        trailingSince = trailingSince === -1 ? idx : trailingSince;
        const trailing = idx - trailingSince + 1;
        currentHunk.lines.push(` ${edit.text}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;

        if (trailing > CONTEXT * 2) {
          const excess = trailing - CONTEXT;
          for (let i = 0; i < excess; i++) currentHunk.lines.pop();
          currentHunk.oldCount -= excess;
          currentHunk.newCount -= excess;
          hunks.push(currentHunk);
          currentHunk = undefined;
          trailingSince = -1;
        }
      }
      oldLine++;
      newLine++;
      continue;
    }

    trailingSince = -1;

    if (!currentHunk) {
      const contextStart = Math.max(0, oldLine - CONTEXT);
      const contextNewStart = Math.max(0, newLine - CONTEXT);
      const contextLines = before.slice(contextStart, oldLine);
      currentHunk = {
        oldStart: contextStart + 1,
        oldCount: contextLines.length,
        newStart: contextNewStart + 1,
        newCount: contextLines.length,
        lines: contextLines.map((l) => ` ${l}`),
      };
    }

    if (edit.type === "delete") {
      currentHunk.lines.push(`-${edit.text}`);
      currentHunk.oldCount++;
      oldLine++;
    } else {
      currentHunk.lines.push(`+${edit.text}`);
      currentHunk.newCount++;
      newLine++;
    }
  }

  if (currentHunk) {
    if (trailingSince !== -1) {
      const trailing = edits.length - trailingSince;
      const excess = Math.max(0, trailing - CONTEXT);
      for (let i = 0; i < excess; i++) currentHunk.lines.pop();
      currentHunk.oldCount -= excess;
      currentHunk.newCount -= excess;
    }
    hunks.push(currentHunk);
  }

  return hunks;
}

function formatHunk(hunk: Hunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  return `${header}\n${hunk.lines.join("\n")}`;
}

interface Edit {
  type: "equal" | "delete" | "insert";
  text: string;
}

function computeEdits(a: string[], b: string[]): Edit[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (!row || !prevRow) continue;
      if (a[i - 1] === b[j - 1]) {
        row[j] = (prevRow[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }

  const edits: Edit[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      edits.push({ type: "equal", text: a[i - 1] ?? "" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
      edits.push({ type: "insert", text: b[j - 1] ?? "" });
      j--;
    } else {
      edits.push({ type: "delete", text: a[i - 1] ?? "" });
      i--;
    }
  }

  return edits.reverse();
}
