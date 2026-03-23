import { z } from "zod";

/**
 * Schema for a code review finding. Shared across VCS agents (gh, bb).
 */
export const FindingSchema = z.object({
  severity: z.string(),
  category: z.string(),
  file: z.string(),
  start_line: z.number().optional(),
  line: z.number(),
  title: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * Build the markdown body for an inline PR comment from a finding.
 */
export function buildCommentBody(finding: Finding): string {
  const parts = [
    `**${finding.severity}** — ${finding.title}`,
    "",
    `**Category:** ${finding.category}`,
    "",
    finding.description,
  ];

  if (finding.suggestion) {
    parts.push("", "```suggestion", finding.suggestion, "```");
  }

  return parts.join("\n");
}

/**
 * Build summary sections for findings that failed to post inline (outside diff range).
 */
export function buildFailedFindingsSummary(
  failed: Array<{ path: string; line: number }>,
  findings: Finding[],
): string[] {
  const parts: string[] = [];
  for (const f of failed) {
    const finding = findings.find((x) => x.file === f.path && x.line === f.line);
    if (finding) {
      parts.push(
        "",
        "<details>",
        `<summary><b>${finding.severity}</b> · <code>${finding.file}:${finding.line}</code> — ${finding.title}</summary>`,
        "",
        `**Category:** ${finding.category}`,
        "",
        finding.description,
        finding.suggestion ? `\n**Suggestion:**\n\`\`\`\n${finding.suggestion}\n\`\`\`` : "",
        "",
        "</details>",
      );
    }
  }
  return parts;
}
