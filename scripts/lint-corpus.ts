#!/usr/bin/env -S deno run -A
/**
 * Lint-rule calibration run.
 *
 * Runs `lintSkill` over every skill currently in SkillStorage plus the five
 * @atlas/* draft skills under `docs/plans/drafts/`. Aggregates per-rule
 * counts and prints a report. Any rule whose warning rate exceeds the
 * 20% threshold — or that flags an existing skill as a hard error —
 * should be demoted or removed before rollout.
 *
 * Usage:
 *   deno run -A scripts/lint-corpus.ts
 *   deno run -A scripts/lint-corpus.ts --markdown > docs/learnings/...-corpus.md
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { LintFinding, LintResult } from "@atlas/skills";
import { extractArchiveContents, lintSkill, parseSkillMd, SkillStorage } from "@atlas/skills";

const DRAFT_DIRS = ["docs/plans/drafts/authoring-skills"];
const FALSE_POSITIVE_THRESHOLD = 0.2;

interface SkillSample {
  label: string;
  name: string;
  frontmatter: Record<string, unknown>;
  instructions: string;
  archiveFiles?: string[];
  archiveContents?: Record<string, string>;
}

async function loadStoredSkills(): Promise<SkillSample[]> {
  const result = await SkillStorage.list(undefined, undefined, true);
  if (!result.ok) {
    console.error("Failed to list skills:", result.error);
    return [];
  }
  const samples: SkillSample[] = [];
  for (const summary of result.data) {
    const full = await SkillStorage.get(
      summary.namespace,
      summary.name ?? "",
      summary.latestVersion,
    );
    if (!full.ok || !full.data) continue;
    const skill = full.data;
    let archiveFiles: string[] | undefined;
    let archiveContents: Record<string, string> | undefined;
    if (skill.archive) {
      try {
        archiveContents = await extractArchiveContents(new Uint8Array(skill.archive));
        archiveFiles = Object.keys(archiveContents);
      } catch (_err) {
        // Archive extraction failures are acceptable — the linter still has
        // enough to cover frontmatter/body rules.
      }
    }
    samples.push({
      label: `stored:@${skill.namespace}/${skill.name ?? "<unnamed>"}@v${String(skill.version)}`,
      name: skill.name ?? "unnamed",
      frontmatter: skill.frontmatter,
      instructions: skill.instructions,
      archiveFiles,
      archiveContents,
    });
  }
  return samples;
}

async function collectDirFiles(
  dir: string,
  base: string,
  out: { archiveFiles: string[]; archiveContents: Record<string, string> },
  rel = "",
): Promise<void> {
  try {
    for (const entry of await readdir(join(dir, base, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const fullRel = `${base}/${relPath}`;
      if (entry.isDirectory()) {
        await collectDirFiles(dir, base, out, relPath);
      } else {
        out.archiveFiles.push(fullRel);
        try {
          out.archiveContents[fullRel] = await readFile(join(dir, fullRel), "utf-8");
        } catch {
          // binary files — skip
        }
      }
    }
  } catch {
    // directory missing
  }
}

async function loadDraftSkills(): Promise<SkillSample[]> {
  const samples: SkillSample[] = [];
  for (const dir of DRAFT_DIRS) {
    const skillMdPath = join(dir, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseSkillMd(content);
    if (!parsed.ok) continue;
    const { frontmatter, instructions } = parsed.data;

    const out = { archiveFiles: [] as string[], archiveContents: {} as Record<string, string> };
    await collectDirFiles(dir, "references", out);
    await collectDirFiles(dir, "scripts", out);
    await collectDirFiles(dir, "assets", out);

    const nameFromDir = dir.split("/").pop() ?? "unnamed";
    samples.push({
      label: `draft:${dir}`,
      name: typeof frontmatter.name === "string" ? frontmatter.name : nameFromDir,
      frontmatter,
      instructions,
      archiveFiles: out.archiveFiles,
      archiveContents: out.archiveContents,
    });
  }
  return samples;
}

interface RuleStats {
  warn: number;
  error: number;
  samples: Array<{ label: string; finding: LintFinding }>;
}

function aggregate(samples: SkillSample[]): {
  total: number;
  byRule: Map<string, RuleStats>;
  perSample: Array<{ label: string; result: LintResult }>;
} {
  const byRule = new Map<string, RuleStats>();
  const perSample: Array<{ label: string; result: LintResult }> = [];
  for (const sample of samples) {
    const result = lintSkill(
      {
        name: sample.name,
        frontmatter: sample.frontmatter,
        instructions: sample.instructions,
        archiveFiles: sample.archiveFiles,
        archiveContents: sample.archiveContents,
      },
      "publish",
    );
    perSample.push({ label: sample.label, result });
    for (const finding of [...result.warnings, ...result.errors]) {
      const stats = byRule.get(finding.rule) ?? { warn: 0, error: 0, samples: [] };
      if (finding.severity === "error") stats.error += 1;
      else stats.warn += 1;
      if (stats.samples.length < 3) {
        stats.samples.push({ label: sample.label, finding });
      }
      byRule.set(finding.rule, stats);
    }
  }
  return { total: samples.length, byRule, perSample };
}

function formatReport(
  args: {
    total: number;
    byRule: Map<string, RuleStats>;
    perSample: Array<{ label: string; result: LintResult }>;
  },
  markdown: boolean,
): string {
  const { total, byRule, perSample } = args;
  const lines: string[] = [];
  const rules = [...byRule.entries()].sort(
    (a, b) => b[1].warn + b[1].error - (a[1].warn + a[1].error),
  );

  if (markdown) {
    lines.push("# Lint corpus report");
    lines.push("");
    lines.push(`Corpus size: **${String(total)}** skills.`);
    lines.push("");
    lines.push(
      `Decision threshold: rules firing on >${String(FALSE_POSITIVE_THRESHOLD * 100)}% of samples are candidates for demotion or rule adjustment.`,
    );
    lines.push("");
    lines.push("## Rule hit rates");
    lines.push("");
    lines.push("| Rule | Warn | Error | Rate | Verdict |");
    lines.push("|---|---:|---:|---:|---|");
    for (const [rule, stats] of rules) {
      const rate = (stats.warn + stats.error) / Math.max(1, total);
      const verdict =
        stats.error > 0
          ? "🚨 hard error on existing skill — demote or relax"
          : rate > FALSE_POSITIVE_THRESHOLD
            ? "⚠️ above threshold — consider demoting to info"
            : "✅ within threshold";
      lines.push(
        `| \`${rule}\` | ${String(stats.warn)} | ${String(stats.error)} | ${(rate * 100).toFixed(1)}% | ${verdict} |`,
      );
    }
    lines.push("");
    lines.push("## Per-sample findings");
    lines.push("");
    for (const sample of perSample) {
      const totals = sample.result.warnings.length + sample.result.errors.length;
      if (totals === 0) continue;
      lines.push(`### ${sample.label}`);
      for (const f of [...sample.result.errors, ...sample.result.warnings]) {
        lines.push(`- \`${f.rule}\` (${f.severity}): ${f.message}`);
      }
      lines.push("");
    }
  } else {
    lines.push(`Corpus size: ${String(total)} skills`);
    lines.push(`Threshold: >${String(FALSE_POSITIVE_THRESHOLD * 100)}% rate → demote`);
    lines.push("");
    lines.push("Rule                          warn  error  rate   verdict");
    lines.push("----------------------------  ----  -----  -----  ---------------------------");
    for (const [rule, stats] of rules) {
      const rate = (stats.warn + stats.error) / Math.max(1, total);
      const verdict =
        stats.error > 0
          ? "HARD ERROR — demote or relax"
          : rate > FALSE_POSITIVE_THRESHOLD
            ? "above threshold"
            : "ok";
      lines.push(
        `${rule.padEnd(30)}${String(stats.warn).padStart(4)}  ${String(stats.error).padStart(5)}  ${(rate * 100).toFixed(1).padStart(5)}  ${verdict}`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const markdown = args.includes("--markdown");

  const stored = await loadStoredSkills();
  const drafts = await loadDraftSkills();
  const samples = [...stored, ...drafts];

  if (samples.length === 0) {
    console.error("No skills found in storage or drafts");
    return 1;
  }

  const aggregated = aggregate(samples);
  console.log(formatReport(aggregated, markdown));

  // Exit non-zero if any existing skill triggers a hard error — surfaces
  // problems immediately in CI if we wire this into the pre-release gate.
  for (const entry of aggregated.perSample) {
    if (entry.result.errors.length > 0) return 2;
  }
  return 0;
}

process.exit(await main());
