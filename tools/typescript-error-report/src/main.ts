// deno-lint-ignore-file no-control-regex
/** biome-ignore-all lint/suspicious/noControlCharactersInRegex: see stripAnsiCodes */

/**
 * Analyze TypeScript, Deno lint, and Biome violations across the codebase.
 * Runs all three tools, parses their output, and generates a markdown report showing:
 * - Error counts by type, rule, file, and project
 * - Workspace dependency analysis
 * - Recommended fix order based on dependency graph
 * - Common issue patterns across files
 *
 * Helpful reference material:
 * @see https://typescript.tv/errors/
 * @see https://docs.deno.com/lint/
 * @see https://biomejs.dev/linter/javascript/rules/
 */

import { join, relative } from "@std/path";
import { z } from "zod";

const TSErrorSchema = z.object({
  errorCode: z.string(),
  message: z.string(),
  filePath: z.string(),
  line: z.number(),
  column: z.number(),
});

type TSError = z.infer<typeof TSErrorSchema>;

const LintViolationSchema = z.object({
  ruleName: z.string(),
  severity: z.string(),
  message: z.string(),
  filePath: z.string(),
  line: z.number(),
  column: z.number(),
  hint: z.string().optional(),
});

type LintViolation = z.infer<typeof LintViolationSchema>;

const BiomeViolationSchema = z.object({
  ruleName: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  filePath: z.string(),
  line: z.number(),
  column: z.number(),
  category: z.string(),
  fixable: z.boolean(),
});

type BiomeViolation = z.infer<typeof BiomeViolationSchema>;

const WorkspaceDependencySchema = z.object({
  name: z.string(),
  path: z.string(),
  imports: z.array(z.string()),
  dependencies: z.array(z.string()),
  dependents: z.array(z.string()),
});

type WorkspaceDependency = z.infer<typeof WorkspaceDependencySchema>;

interface IssuesByFile {
  errors: TSError[];
  violations: LintViolation[];
  biomeViolations: BiomeViolation[];
}

interface ProjectIssues {
  project: string;
  errors: number;
  violations: number;
  biomeViolations: number;
  total: number;
}

/**
 * Run a Deno command and capture its output.
 * @param args Command arguments to pass to Deno
 * @param description Human-readable description for logging
 * @returns Combined stdout and stderr output
 */
async function runCommand(args: string[], description: string): Promise<string> {
  console.log(`Running ${description}...`);
  const command = new Deno.Command("deno", {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });

  const process = command.spawn();
  const output: string[] = [];

  const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  };

  await Promise.all([
    readStream(process.stdout.getReader()),
    readStream(process.stderr.getReader()),
  ]);

  await process.status;
  const fullOutput = output.join("");
  console.log(`Captured ${fullOutput.length} characters of output`);
  return fullOutput;
}

/**
 * Remove ANSI escape codes from terminal output.
 */
function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Determine which project/package a file belongs to.
 * @returns Project name like "apps/web-client" or "packages/core"
 */
function getProjectCategory(filePath: string): string {
  const relativePath = relative(Deno.cwd(), filePath);

  if (relativePath.startsWith("apps/")) {
    return `apps/${relativePath.split("/")[1]}`;
  }
  if (relativePath.startsWith("packages/")) {
    return `packages/${relativePath.split("/")[1]}`;
  }
  if (relativePath.startsWith("tools/")) {
    return `tools/${relativePath.split("/")[1]}`;
  }
  if (relativePath.startsWith("src/")) {
    return "src";
  }
  if (relativePath.startsWith("tests/")) {
    return "tests";
  }
  return "other";
}

/**
 * Parse `deno check` output to extract TypeScript errors.
 * Matches error codes, messages, and file locations.
 */
function parseTypeScriptErrors(output: string): TSError[] {
  const errors: TSError[] = [];
  const cleanOutput = stripAnsiCodes(output);
  const lines = cleanOutput.split("\n");

  let currentError: Partial<TSError> | null = null;

  for (const line of lines) {
    if (!line) continue;

    const errorMatch = line.match(/(TS\d+)\s+\[ERROR\]:\s+(.*)$/);
    if (errorMatch?.[1] && errorMatch?.[2]) {
      if (currentError?.filePath) {
        try {
          errors.push(TSErrorSchema.parse(currentError));
        } catch {
          // Skip invalid errors
        }
      }
      currentError = { errorCode: errorMatch[1], message: errorMatch[2].trim() };
      continue;
    }

    const locationMatch = line.match(/at\s+file:\/\/(.+?):(\d+):(\d+)/);
    if (locationMatch?.[1] && locationMatch?.[2] && locationMatch?.[3] && currentError) {
      currentError.filePath = locationMatch[1];
      currentError.line = parseInt(locationMatch[2], 10);
      currentError.column = parseInt(locationMatch[3], 10);
    }
  }

  if (currentError?.filePath) {
    try {
      errors.push(TSErrorSchema.parse(currentError));
    } catch {
      // Skip invalid errors
    }
  }

  return errors;
}

/**
 * Parse `deno lint` output to extract violations.
 * Handles multi-line hints and location tracking.
 */
function parseLintViolations(output: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const cleanOutput = stripAnsiCodes(output);
  const lines = cleanOutput.split("\n");

  let currentViolation: Partial<LintViolation> | null = null;
  let captureHint = false;

  for (const line of lines) {
    if (!line) continue;

    const violationMatch = line.match(/^(error|warning)\[([^\]]+)\]:\s+(.*)$/);
    if (violationMatch?.[1] && violationMatch?.[2] && violationMatch?.[3]) {
      if (currentViolation?.filePath) {
        try {
          violations.push(LintViolationSchema.parse(currentViolation));
        } catch {
          // Skip invalid violations
        }
      }

      currentViolation = {
        severity: violationMatch[1],
        ruleName: violationMatch[2],
        message: violationMatch[3].trim(),
      };
      captureHint = false;
      continue;
    }

    const locationMatch = line.match(/^\s*-->\s+(.+?):(\d+):(\d+)$/);
    if (locationMatch?.[1] && locationMatch?.[2] && locationMatch?.[3] && currentViolation) {
      let filePath = locationMatch[1];
      if (filePath.startsWith("file://")) {
        filePath = filePath.substring(7);
      }
      currentViolation.filePath = filePath;
      currentViolation.line = parseInt(locationMatch[2], 10);
      currentViolation.column = parseInt(locationMatch[3], 10);
      continue;
    }

    const hintMatch = line.match(/^\s*=\s*hint:\s+(.*)$/);
    if (hintMatch?.[1] && currentViolation) {
      currentViolation.hint = hintMatch[1].trim();
      captureHint = false;
      continue;
    }

    if (line.includes("= hint:") && !hintMatch) {
      captureHint = true;
      continue;
    }

    if (captureHint && currentViolation && line.trim()) {
      currentViolation.hint = `${currentViolation.hint || ""} ${line.trim()}`;
    }

    if (line.includes("docs:")) {
      captureHint = false;
    }
  }

  if (currentViolation?.filePath) {
    try {
      violations.push(LintViolationSchema.parse(currentViolation));
    } catch {
      // Skip invalid violations
    }
  }

  return violations;
}

/**
 * Parse Biome check output to extract violations.
 * Handles severity indicators and multi-line messages.
 */
function parseBiomeViolations(output: string): BiomeViolation[] {
  const violations: BiomeViolation[] = [];
  const cleanOutput = stripAnsiCodes(output);
  const lines = cleanOutput.split("\n");

  let currentViolation: Partial<BiomeViolation> | null = null;
  let captureMessage = false;
  let messageLines: string[] = [];

  for (const line of lines) {
    if (!line) continue;

    const headerMatch = line.match(/^(.+?):(\d+):(\d+)\s+lint\/([^/]+)\/([^\s]+)\s*(FIXABLE)?/);
    if (
      headerMatch?.[1] &&
      headerMatch?.[2] &&
      headerMatch?.[3] &&
      headerMatch?.[4] &&
      headerMatch?.[5]
    ) {
      if (currentViolation?.filePath) {
        if (messageLines.length > 0) {
          currentViolation.message = messageLines.join(" ").trim();
        }
        try {
          violations.push(BiomeViolationSchema.parse(currentViolation));
        } catch {
          // Skip invalid violations
        }
      }

      currentViolation = {
        filePath: headerMatch[1],
        line: parseInt(headerMatch[2], 10),
        column: parseInt(headerMatch[3], 10),
        category: headerMatch[4],
        ruleName: `${headerMatch[4]}/${headerMatch[5]}`,
        fixable: headerMatch[6] === "FIXABLE",
        severity: "warning",
      };
      captureMessage = false;
      messageLines = [];
      continue;
    }

    const severityMatch = line.match(/^\s*(×|i)\s+(.*)$/);
    if (severityMatch?.[1] && severityMatch?.[2] && currentViolation) {
      currentViolation.severity = severityMatch[1] === "×" ? "error" : "warning";
      messageLines.push(severityMatch[2]);
      captureMessage = true;
      continue;
    }

    if (captureMessage && line.trim() && !line.match(/^\s*\d+\s*[│|]/) && !line.includes("━")) {
      if (!line.match(/^\s*[>|]\s*\d+/)) {
        messageLines.push(line.trim());
      } else {
        captureMessage = false;
      }
    }

    if (line.includes("━") || line.match(/^\s*\d+\s*[│|]/)) {
      captureMessage = false;
    }
  }

  if (currentViolation?.filePath) {
    if (messageLines.length > 0) {
      currentViolation.message = messageLines.join(" ").trim();
    }
    try {
      violations.push(BiomeViolationSchema.parse(currentViolation));
    } catch {
      // Skip invalid violations
    }
  }

  return violations;
}

/**
 * Find all workspaces in a directory by looking for deno.json files.
 */
async function findWorkspaces(dir: string): Promise<{ name: string; path: string }[]> {
  const workspaces: { name: string; path: string }[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        const wsPath = join(dir, entry.name);
        const denoJsonPath = join(wsPath, "deno.json");

        try {
          await Deno.stat(denoJsonPath);
          workspaces.push({ name: entry.name, path: wsPath });
        } catch {
          // Skip directories without deno.json
        }
      }
    }
  } catch {
    // Skip if directory doesn't exist
  }

  return workspaces;
}

/**
 * Recursively find all TypeScript files in a directory.
 */
async function findTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);

      if (entry.isDirectory && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        files.push(...(await findTypeScriptFiles(path)));
      } else if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(path);
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return files;
}

/**
 * Analyze import statements to build a dependency graph of workspaces.
 * Identifies which packages depend on which others.
 */
async function analyzeWorkspaceDependencies(): Promise<WorkspaceDependency[]> {
  const workspaces: WorkspaceDependency[] = [];
  const workspacePaths = [
    ...(await findWorkspaces("apps")),
    ...(await findWorkspaces("packages")),
    ...(await findWorkspaces("tools")),
    { name: "src", path: "./src" },
  ];

  for (const ws of workspacePaths) {
    const denoJsonPath = join(ws.path, "deno.json");
    let imports: string[] = [];

    try {
      await Deno.readTextFile(denoJsonPath); // Verify file exists

      const tsFiles = await findTypeScriptFiles(ws.path);
      const internalImports = new Set<string>();
      for (const file of tsFiles) {
        const content = await Deno.readTextFile(file);
        const importMatches = content.matchAll(/import\s+.*?\s+from\s+["'](@atlas\/[^"']+)["']/g);
        for (const match of importMatches) {
          if (match[1]) {
            internalImports.add(match[1]);
          }
        }
      }

      imports = Array.from(internalImports);
    } catch {
      // Skip workspaces we can't read
    }

    workspaces.push({ name: ws.name, path: ws.path, imports, dependencies: [], dependents: [] });
  }

  for (const ws of workspaces) {
    ws.dependencies = ws.imports
      .map((imp) => {
        const match = imp.match(/@atlas\/([^/]+)/);
        return match?.[1] ?? null;
      })
      .filter((dep): dep is string => dep !== null && dep !== ws.name)
      .filter((dep, index, self) => self.indexOf(dep) === index);
  }

  for (const ws of workspaces) {
    for (const dep of ws.dependencies) {
      const depWorkspace = workspaces.find((w) => w.name === dep);
      if (depWorkspace && !depWorkspace.dependents.includes(ws.name)) {
        depWorkspace.dependents.push(ws.name);
      }
    }
  }

  return workspaces;
}

/**
 * Count errors by TypeScript error code.
 */
function aggregateByType(errors: TSError[]): Map<string, number> {
  const errorsByType = new Map<string, number>();
  for (const error of errors) {
    errorsByType.set(error.errorCode, (errorsByType.get(error.errorCode) || 0) + 1);
  }
  return errorsByType;
}

/**
 * Count violations by lint rule name.
 */
function aggregateByRule(violations: LintViolation[]): Map<string, number> {
  const violationsByRule = new Map<string, number>();
  for (const violation of violations) {
    violationsByRule.set(violation.ruleName, (violationsByRule.get(violation.ruleName) || 0) + 1);
  }
  return violationsByRule;
}

/**
 * Count violations by Biome rule name.
 */
function aggregateBiomeByRule(violations: BiomeViolation[]): Map<string, number> {
  const violationsByRule = new Map<string, number>();
  for (const violation of violations) {
    violationsByRule.set(violation.ruleName, (violationsByRule.get(violation.ruleName) || 0) + 1);
  }
  return violationsByRule;
}

/**
 * Group all issues by file path.
 */
function aggregateByFile(
  errors: TSError[],
  violations: LintViolation[],
  biomeViolations: BiomeViolation[],
): Map<string, IssuesByFile> {
  const fileIssues = new Map<string, IssuesByFile>();

  for (const error of errors) {
    const relativePath = relative(Deno.cwd(), error.filePath);
    if (!fileIssues.has(relativePath)) {
      fileIssues.set(relativePath, { errors: [], violations: [], biomeViolations: [] });
    }
    const issues = fileIssues.get(relativePath);
    if (issues) {
      issues.errors.push(error);
    }
  }

  for (const violation of violations) {
    const relativePath = relative(Deno.cwd(), violation.filePath);
    if (!fileIssues.has(relativePath)) {
      fileIssues.set(relativePath, { errors: [], violations: [], biomeViolations: [] });
    }
    const issues = fileIssues.get(relativePath);
    if (issues) {
      issues.violations.push(violation);
    }
  }

  for (const violation of biomeViolations) {
    const relativePath = relative(Deno.cwd(), violation.filePath);
    if (!fileIssues.has(relativePath)) {
      fileIssues.set(relativePath, { errors: [], violations: [], biomeViolations: [] });
    }
    const issues = fileIssues.get(relativePath);
    if (issues) {
      issues.biomeViolations.push(violation);
    }
  }

  return fileIssues;
}

/**
 * Group issues by project/package.
 */
function aggregateByProject(
  errors: TSError[],
  violations: LintViolation[],
  biomeViolations: BiomeViolation[],
): ProjectIssues[] {
  const projectMap = new Map<string, ProjectIssues>();

  for (const error of errors) {
    const project = getProjectCategory(error.filePath);
    if (!projectMap.has(project)) {
      projectMap.set(project, { project, errors: 0, violations: 0, biomeViolations: 0, total: 0 });
    }
    const projectIssue = projectMap.get(project);
    if (projectIssue) {
      projectIssue.errors++;
    }
  }

  for (const violation of violations) {
    const project = getProjectCategory(violation.filePath);
    if (!projectMap.has(project)) {
      projectMap.set(project, { project, errors: 0, violations: 0, biomeViolations: 0, total: 0 });
    }
    const projectIssue = projectMap.get(project);
    if (projectIssue) {
      projectIssue.violations++;
    }
  }

  for (const violation of biomeViolations) {
    const project = getProjectCategory(violation.filePath);
    if (!projectMap.has(project)) {
      projectMap.set(project, { project, errors: 0, violations: 0, biomeViolations: 0, total: 0 });
    }
    const projectIssue = projectMap.get(project);
    if (projectIssue) {
      projectIssue.biomeViolations++;
    }
  }

  const projectIssues = Array.from(projectMap.values());
  for (const p of projectIssues) {
    p.total = p.errors + p.violations + p.biomeViolations;
  }

  return projectIssues.sort((a, b) => b.total - a.total);
}

/**
 * Generate the summary section with overall statistics.
 */
function generateSummarySection(
  errors: TSError[],
  violations: LintViolation[],
  biomeViolations: BiomeViolation[],
  timestamp: Date,
): string {
  const totalErrors = errors.length;
  const totalViolations = violations.length;
  const totalBiomeViolations = biomeViolations.length;
  const biomeErrors = biomeViolations.filter((v) => v.severity === "error").length;
  const biomeWarnings = biomeViolations.filter((v) => v.severity === "warning").length;

  const errorsByFile = new Set(errors.map((e) => e.filePath)).size;
  const violationsByFile = new Set(violations.map((v) => v.filePath)).size;
  const biomeViolationsByFile = new Set(biomeViolations.map((v) => v.filePath)).size;

  return `# TypeScript & Lint Analysis Report

**Generated:** ${timestamp.toISOString()}

**Total Issues:** ${totalErrors + totalViolations + totalBiomeViolations} (${totalErrors} type errors, ${totalViolations} deno lint violations, ${totalBiomeViolations} biome violations)

## Summary Statistics

### TypeScript Errors
- **Total errors:** ${totalErrors}
- **Unique error types:** ${new Set(errors.map((e) => e.errorCode)).size}
- **Files with errors:** ${errorsByFile}

### Deno Lint Violations
- **Total violations:** ${totalViolations}
- **Unique rules violated:** ${new Set(violations.map((v) => v.ruleName)).size}
- **Files with violations:** ${violationsByFile}

### Biome Violations
- **Total violations:** ${totalBiomeViolations}
- **Errors:** ${biomeErrors}
- **Warnings:** ${biomeWarnings}
- **Unique rules violated:** ${new Set(biomeViolations.map((v) => v.ruleName)).size}
- **Files with violations:** ${biomeViolationsByFile}
`;
}

/**
 * Generate table of TypeScript error types and counts.
 */
function generateErrorTypesSection(errors: TSError[]): string {
  if (errors.length === 0) {
    return "\n## TypeScript Error Types Breakdown\n\nNo TypeScript errors found.\n";
  }

  const errorsByType = aggregateByType(errors);
  const sortedErrorTypes = Array.from(errorsByType.entries()).sort((a, b) => b[1] - a[1]);

  let section = "\n## TypeScript Error Types Breakdown\n\n";
  section += "| Error Code | Count | Percentage | Description |\n";
  section += "|------------|-------|------------|-------------|\n";

  for (const [code, count] of sortedErrorTypes) {
    const percentage = ((count / errors.length) * 100).toFixed(1);
    const description = getErrorDescription(code);
    section += `| ${code} | ${count} | ${percentage}% | ${description} |\n`;
  }

  return section;
}

/**
 * Generate table of lint rules and violation counts.
 */
function generateLintRulesSection(violations: LintViolation[]): string {
  if (violations.length === 0) {
    return "\n## Deno Lint Rules Breakdown\n\nNo lint violations found.\n";
  }

  const violationsByRule = aggregateByRule(violations);
  const sortedRules = Array.from(violationsByRule.entries()).sort((a, b) => b[1] - a[1]);

  let section = "\n## Deno Lint Rules Breakdown\n\n";
  section += "| Rule Name | Count | Percentage | Description |\n";
  section += "|-----------|-------|------------|-------------|\n";

  const maxRules = 30;
  for (const [rule, count] of sortedRules.slice(0, maxRules)) {
    const percentage = ((count / violations.length) * 100).toFixed(1);
    const description = getLintRuleDescription(rule);
    section += `| ${rule} | ${count} | ${percentage}% | ${description} |\n`;
  }

  if (sortedRules.length > maxRules) {
    section += `| ... and ${sortedRules.length - maxRules} more rules | | | |\n`;
  }

  return section;
}

/**
 * Generate table of Biome rules and violation counts.
 */
function generateBiomeRulesSection(violations: BiomeViolation[]): string {
  if (violations.length === 0) {
    return "\n## Biome Rules Breakdown\n\nNo biome violations found.\n";
  }

  const violationsByRule = aggregateBiomeByRule(violations);
  const sortedRules = Array.from(violationsByRule.entries()).sort((a, b) => b[1] - a[1]);

  let section = "\n## Biome Rules Breakdown\n\n";
  section += "| Rule Name | Count | Percentage | Severity Distribution |\n";
  section += "|-----------|-------|------------|----------------------|\n";

  const maxRules = 30;
  for (const [rule, count] of sortedRules.slice(0, maxRules)) {
    const percentage = ((count / violations.length) * 100).toFixed(1);
    const ruleViolations = violations.filter((v) => v.ruleName === rule);
    const errors = ruleViolations.filter((v) => v.severity === "error").length;
    const warnings = ruleViolations.filter((v) => v.severity === "warning").length;
    const severityDist =
      errors > 0 && warnings > 0
        ? `${errors}E/${warnings}W`
        : errors > 0
          ? `${errors}E`
          : `${warnings}W`;
    section += `| ${rule} | ${count} | ${percentage}% | ${severityDist} |\n`;
  }

  if (sortedRules.length > maxRules) {
    section += `| ... and ${sortedRules.length - maxRules} more rules | | | |\n`;
  }

  return section;
}

/**
 * Generate table of files with the most issues.
 */
function generateFilesSection(fileIssues: Map<string, IssuesByFile>): string {
  const sortedFiles = Array.from(fileIssues.entries()).sort((a, b) => {
    const totalA = a[1].errors.length + a[1].violations.length + a[1].biomeViolations.length;
    const totalB = b[1].errors.length + b[1].violations.length + b[1].biomeViolations.length;
    return totalB - totalA;
  });

  let section = "\n## Files with Most Issues\n\n";
  section += "| File | Type Errors | Deno Lint | Biome | Total |\n";
  section += "|------|-------------|-----------|-------|-------|\n";

  const maxFiles = 20;
  for (const [file, issues] of sortedFiles.slice(0, maxFiles)) {
    const total = issues.errors.length + issues.violations.length + issues.biomeViolations.length;
    section += `| ${file} | ${issues.errors.length} | ${issues.violations.length} | ${issues.biomeViolations.length} | ${total} |\n`;
  }

  if (sortedFiles.length > maxFiles) {
    section += `| ... and ${sortedFiles.length - maxFiles} more files | | | |\n`;
  }

  return section;
}

/**
 * Generate table of issues grouped by project.
 */
function generateProjectsSection(projectIssues: ProjectIssues[]): string {
  let section = "\n## Issues by Project\n\n";
  section += "| Project | Type Errors | Deno Lint | Biome | Total |\n";
  section += "|---------|-------------|-----------|-------|-------|\n";

  for (const p of projectIssues) {
    section += `| ${p.project} | ${p.errors} | ${p.violations} | ${p.biomeViolations} | ${p.total} |\n`;
  }

  return section;
}

/**
 * Generate dependency graph visualization.
 */
function generateDependencySection(dependencies: WorkspaceDependency[]): string {
  const sortedDeps = dependencies
    .map((d) => ({ ...d, complexityScore: d.dependencies.length + d.dependents.length * 2 }))
    .sort((a, b) => b.complexityScore - a.complexityScore);

  let section = "\n## Workspace Dependency Graph\n\n";
  section += "### Dependency Analysis\n\n";
  section += "| Package | Dependencies | Dependents | Complexity Score |\n";
  section += "|---------|--------------|------------|------------------|\n";

  for (const dep of sortedDeps) {
    const depsStr = dep.dependencies.length > 0 ? dep.dependencies.join(", ") : "none";
    const dependentsStr = dep.dependents.length > 0 ? dep.dependents.join(", ") : "none";
    section += `| ${dep.name} | ${depsStr} | ${dependentsStr} | ${dep.complexityScore} |\n`;
  }

  return section;
}

/**
 * Generate recommended fix order based on dependency graph.
 * Start with leaf nodes, then middle tier, then core packages.
 */
function generateFixOrderSection(
  dependencies: WorkspaceDependency[],
  projectIssues: ProjectIssues[],
): string {
  const leafNodes = dependencies.filter((d) => d.dependents.length === 0);
  const coreNodes = dependencies.filter((d) => d.dependents.length > 3);
  const middleNodes = dependencies.filter(
    (d) => d.dependents.length > 0 && d.dependents.length <= 3,
  );

  const getErrorCount = (name: string): number => {
    const projects = [`packages/${name}`, `apps/${name}`, `tools/${name}`];
    return projects.reduce((sum, proj) => {
      const p = projectIssues.find((pi) => pi.project === proj);
      return sum + (p?.errors || 0);
    }, 0);
  };

  let section = "\n### Recommended Fix Order\n\n";
  section += "Based on the dependency graph, here's a recommended order for fixing errors:\n\n";

  section += "1. **Start with leaf nodes** (no other packages depend on these):\n";
  for (const node of leafNodes) {
    const errorCount = getErrorCount(node.name);
    if (errorCount > 0) {
      section += `   - ${node.name} (${errorCount} errors)\n`;
    }
  }

  section += "\n2. **Then fix middle-tier packages** (1-3 dependents):\n";
  for (const node of middleNodes) {
    const errorCount = getErrorCount(node.name);
    if (errorCount > 0) {
      section += `   - ${node.name} (${errorCount} errors, ${node.dependents.length} dependents)\n`;
    }
  }

  section += "\n3. **Finally, fix core packages** (many packages depend on these):\n";
  for (const node of coreNodes) {
    const errorCount = getErrorCount(node.name);
    if (errorCount > 0) {
      section += `   - ${node.name} (${errorCount} errors, ${node.dependents.length} dependents)\n`;
    }
  }

  return section;
}

/**
 * Identify common issue patterns and high-impact files.
 */
function generateHotspotsSection(
  errors: TSError[],
  violations: LintViolation[],
  biomeViolations: BiomeViolation[],
  fileIssues: Map<string, IssuesByFile>,
): string {
  const patterns = new Map<string, { files: Set<string>; count: number }>();

  for (const error of errors) {
    const key = `TS${error.errorCode}:${error.message.substring(0, 50)}`;
    if (!patterns.has(key)) {
      patterns.set(key, { files: new Set(), count: 0 });
    }
    const pattern = patterns.get(key);
    if (pattern) {
      pattern.files.add(relative(Deno.cwd(), error.filePath));
      pattern.count++;
    }
  }

  for (const violation of violations) {
    const key = `DENO-LINT${violation.ruleName}:${violation.message.substring(0, 50)}`;
    if (!patterns.has(key)) {
      patterns.set(key, { files: new Set(), count: 0 });
    }
    const pattern = patterns.get(key);
    if (pattern) {
      pattern.files.add(relative(Deno.cwd(), violation.filePath));
      pattern.count++;
    }
  }

  for (const violation of biomeViolations) {
    const key = `BIOME${violation.ruleName}:${violation.message.substring(0, 50)}`;
    if (!patterns.has(key)) {
      patterns.set(key, { files: new Set(), count: 0 });
    }
    const pattern = patterns.get(key);
    if (pattern) {
      pattern.files.add(relative(Deno.cwd(), violation.filePath));
      pattern.count++;
    }
  }

  const commonPatterns = Array.from(patterns.entries())
    .filter(([, pattern]) => pattern.files.size > 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15);

  let section = "\n## Code Quality Hotspots Analysis\n\n";

  if (commonPatterns.length > 0) {
    section += "### Most Common Issue Patterns\n\n";
    section += "Issues that appear across multiple files (potential systematic problems):\n\n";

    for (const [key, pattern] of commonPatterns) {
      const [type, msg] = key.split(":");
      if (!type || !msg) continue;

      let issueType: string;
      let code: string;
      if (type.startsWith("DENO-LINT")) {
        issueType = "Deno Lint";
        code = type.substring(9);
      } else if (type.startsWith("BIOME")) {
        issueType = "Biome";
        code = type.substring(5);
      } else {
        issueType = "Type";
        code = type.substring(2);
      }

      section += `- **[${issueType}] ${code}**: "${msg}..."\n`;
      section += `  - Occurrences: ${pattern.count}\n`;
      section += `  - Files affected: ${pattern.files.size}\n\n`;
    }
  }

  const filesWithMultipleIssueTypes = Array.from(fileIssues.entries())
    .filter(([, issues]) => {
      const hasTypeErrors = issues.errors.length > 0;
      const hasLintViolations = issues.violations.length > 0;
      const hasBiomeViolations = issues.biomeViolations.length > 0;
      const issueTypes = [hasTypeErrors, hasLintViolations, hasBiomeViolations].filter(
        Boolean,
      ).length;
      return issueTypes >= 2;
    })
    .sort((a, b) => {
      const totalA = a[1].errors.length + a[1].violations.length + a[1].biomeViolations.length;
      const totalB = b[1].errors.length + b[1].violations.length + b[1].biomeViolations.length;
      return totalB - totalA;
    })
    .slice(0, 10);

  if (filesWithMultipleIssueTypes.length > 0) {
    section += "### High-Impact Files\n\n";
    section += "Files with issues from multiple tools (need attention):\n\n";
    section += "| File | Type Errors | Deno Lint | Biome | Total |\n";
    section += "|------|-------------|-----------|-------|-------|\n";

    for (const [file, issues] of filesWithMultipleIssueTypes) {
      const total = issues.errors.length + issues.violations.length + issues.biomeViolations.length;
      section += `| ${file} | ${issues.errors.length} | ${issues.violations.length} | ${issues.biomeViolations.length} | ${total} |\n`;
    }

    section += "\n";
  }

  return section;
}

/**
 * Generate complete markdown report.
 */
function generateMarkdownReport(
  errors: TSError[],
  violations: LintViolation[],
  biomeViolations: BiomeViolation[],
  dependencies: WorkspaceDependency[],
  timestamp: Date,
): string {
  const fileIssues = aggregateByFile(errors, violations, biomeViolations);
  const projectIssues = aggregateByProject(errors, violations, biomeViolations);

  let report = "";
  report += generateSummarySection(errors, violations, biomeViolations, timestamp);
  report += generateErrorTypesSection(errors);
  report += generateLintRulesSection(violations);
  report += generateBiomeRulesSection(biomeViolations);
  report += generateFilesSection(fileIssues);
  report += generateProjectsSection(projectIssues);
  report += generateDependencySection(dependencies);
  report += generateFixOrderSection(dependencies, projectIssues);
  report += generateHotspotsSection(errors, violations, biomeViolations, fileIssues);

  return report;
}

/**
 * Get human-readable description for TypeScript error code.
 */
function getErrorDescription(errorCode: string): string {
  const descriptions: Record<string, string> = {
    TS2304: "Cannot find name",
    TS2305: "Module has no exported member",
    TS2307: "Cannot find module",
    TS2322: "Type not assignable",
    TS2339: "Property does not exist on type",
    TS2341: "Property is private",
    TS2345: "Argument type not assignable",
    TS2349: "Cannot invoke expression",
    TS2353: "Object literal has unknown properties",
    TS2416: "Property type not assignable to base",
    TS2531: "Object is possibly 'null'",
    TS2532: "Object is possibly 'undefined'",
    TS2540: "Cannot assign to read-only property",
    TS2554: "Argument count mismatch",
    TS2559: "Type has no common properties",
    TS2571: "Object is of type 'unknown'",
    TS2578: "Unused ts-expect-error directive",
    TS2638: "Cannot augment module",
    TS2683: "this implicitly has type any",
    TS2694: "Namespace has no exported member",
    TS2698: "Spread types may only be object types",
    TS2724: "Module has no default export",
    TS2739: "Type is missing properties",
    TS2740: "Type is missing index signature",
    TS2741: "Property is missing in type",
    TS2769: "No overload matches call",
    TS2820: "Type predicate incorrect",
    TS4104: "Parameter property readonly/mutable conflict",
    TS4114: "This member must have override",
    TS6133: "Variable declared but never used",
    TS6138: "Property declared but never used",
    TS6196: "Catch clause variable unused",
    TS7005: "Variable implicitly has 'any' type",
    TS7006: "Parameter implicitly has any type",
    TS7017: "Type has no index signature",
    TS7034: "Variable implicitly has 'any' type",
    TS7053: "Element implicitly has any type",
    TS18046: "Value is of type 'unknown'",
    TS18047: "Value is possibly 'null'",
    TS18048: "Value is possibly 'undefined'",
    TS18050: "Value is possibly null or undefined",
  };

  return descriptions[errorCode] || "TypeScript error";
}

/**
 * Get human-readable description for lint rule.
 */
function getLintRuleDescription(ruleName: string): string {
  const descriptions: Record<string, string> = {
    "no-unused-vars": "Variable declared but never used",
    "no-explicit-any": "Explicit 'any' type usage",
    "no-control-regex": "Control characters in regex",
    "ban-unused-ignore": "Unused lint ignore directive",
    "prefer-const": "Variable never reassigned",
    "no-empty": "Empty block statement",
    "no-debugger": "Debugger statement present",
    "no-console": "Console statement present",
    "no-duplicate-case": "Duplicate case label",
    "no-empty-function": "Empty function body",
    "no-extra-boolean-cast": "Unnecessary boolean cast",
    "no-fallthrough": "Case statement fallthrough",
    "no-invalid-regexp": "Invalid regular expression",
    "no-redeclare": "Variable redeclaration",
    "no-self-assign": "Self assignment",
    "no-sparse-arrays": "Sparse array literal",
    "no-unreachable": "Unreachable code",
    "no-unsafe-finally": "Control flow in finally",
    "no-unused-labels": "Unused label",
    "no-with": "With statement usage",
    "require-yield": "Generator without yield",
    "valid-typeof": "Invalid typeof comparison",
    eqeqeq: "Use === instead of ==",
    "no-eval": "Eval usage",
    "no-proto": "__proto__ usage",
    "no-var": "var keyword usage",
    "prefer-as-const": "Prefer 'as const' assertion",
    "no-compare-neg-zero": "Comparison with -0",
    "no-cond-assign": "Assignment in condition",
    "no-constant-condition": "Constant condition",
    "no-dupe-args": "Duplicate arguments",
    "no-dupe-else-if": "Duplicate else-if condition",
    "no-dupe-keys": "Duplicate object keys",
    "no-duplicate-imports": "Duplicate imports",
    "no-ex-assign": "Exception parameter reassignment",
    "no-func-assign": "Function reassignment",
    "no-import-assign": "Import reassignment",
    "no-inner-declarations": "Nested declarations",
    "no-invalid-triple-slash-reference": "Invalid triple-slash reference",
    "no-irregular-whitespace": "Irregular whitespace",
    "no-misused-new": "Misused new operator",
    "no-new-symbol": "Symbol constructor with new",
    "no-obj-calls": "Global object as function",
    "no-prototype-builtins": "Object prototype method usage",
    "no-setter-return": "Setter with return value",
    "no-this-before-super": "this/super before super()",
    "no-undef": "Undefined variable",
    "no-unexpected-multiline": "Confusing multiline expression",
    "no-unsafe-negation": "Unsafe negation",
    "constructor-super": "Invalid constructor super()",
    "for-direction": "Invalid for loop direction",
    "getter-return": "Getter without return",
    "no-async-promise-executor": "Async promise executor",
    "no-case-declarations": "Declarations in case/default",
    "no-class-assign": "Class reassignment",
    "no-delete-var": "Delete on variable",
    "no-empty-character-class": "Empty character class",
    "no-empty-pattern": "Empty destructuring pattern",
    "no-global-assign": "Global variable assignment",
    "no-octal": "Octal literal",
    "no-regex-spaces": "Multiple spaces in regex",
    "no-shadow-restricted-names": "Shadowing restricted names",
    "no-useless-catch": "Unnecessary catch clause",
    "no-useless-escape": "Unnecessary escape character",
    "require-await": "Async function without await",
    "no-await-in-loop": "Await inside loop",
    "prefer-namespace-keyword": "Use namespace not module",
    "triple-slash-reference": "Triple-slash reference",
  };

  return descriptions[ruleName] || "Lint rule violation";
}

/**
 * Main entry point. Runs all tools and generates report.
 */
async function main() {
  console.log("TypeScript & Lint Analysis Tool");
  console.log("================================\n");

  const timestamp = new Date();

  console.log("Running deno check, deno lint, and biome...");
  const [checkOutput, lintOutput, biomeOutput] = await Promise.all([
    runCommand(["check"], "deno check"),
    runCommand(["lint"], "deno lint"),
    runCommand(
      ["run", "-A", "npm:@biomejs/biome", "check", "--max-diagnostics=10000"],
      "biome check",
    ),
  ]);

  console.log("Parsing TypeScript errors...");
  const errors = parseTypeScriptErrors(checkOutput);
  console.log(`Found ${errors.length} type errors`);

  console.log("Parsing deno lint violations...");
  const violations = parseLintViolations(lintOutput);
  console.log(`Found ${violations.length} deno lint violations`);

  console.log("Parsing biome violations...");
  const biomeViolations = parseBiomeViolations(biomeOutput);
  console.log(`Found ${biomeViolations.length} biome violations\n`);

  console.log("Analyzing workspace dependencies...");
  const dependencies = await analyzeWorkspaceDependencies();
  console.log(`Analyzed ${dependencies.length} workspaces\n`);

  console.log("Generating markdown report...");
  const report = generateMarkdownReport(
    errors,
    violations,
    biomeViolations,
    dependencies,
    timestamp,
  );

  const reportsDir = join(Deno.cwd(), "reports");
  await Deno.mkdir(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, "typescript-errors-report.md");
  await Deno.writeTextFile(reportPath, report);

  console.log(`\n✅ Report generated: ${reportPath}`);
  console.log(`\nSummary:`);
  console.log(`- Total issues: ${errors.length + violations.length + biomeViolations.length}`);
  console.log(`  - Type errors: ${errors.length}`);
  console.log(`  - Deno lint violations: ${violations.length}`);
  console.log(`  - Biome violations: ${biomeViolations.length}`);
  console.log(`- Unique error types: ${new Set(errors.map((e) => e.errorCode)).size}`);
  console.log(`- Unique deno lint rules: ${new Set(violations.map((v) => v.ruleName)).size}`);
  console.log(`- Unique biome rules: ${new Set(biomeViolations.map((v) => v.ruleName)).size}`);
  console.log(`- Files with type errors: ${new Set(errors.map((e) => e.filePath)).size}`);
  console.log(
    `- Files with deno lint violations: ${new Set(violations.map((v) => v.filePath)).size}`,
  );
  console.log(
    `- Files with biome violations: ${new Set(biomeViolations.map((v) => v.filePath)).size}`,
  );

  console.log(`\nFormatting report with deno fmt...`);
  const formatCommand = new Deno.Command("deno", {
    args: ["fmt", reportPath],
    stdout: "piped",
    stderr: "piped",
  });

  const formatResult = await formatCommand.output();
  if (formatResult.success) {
    console.log(`✅ Report formatted successfully`);
  } else {
    const stderr = new TextDecoder().decode(formatResult.stderr);
    console.log(`⚠️  Formatting failed: ${stderr}`);
  }
}

if (import.meta.main) {
  await main();
}
