const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { spawn } = require("node:child_process");

let reportPromise;

function repoRoot() {
  return path.resolve(__dirname, "../../../..");
}

async function readReport(reportPath) {
  return JSON.parse(await readFile(reportPath, "utf8"));
}

async function runScenario() {
  if (process.env.SKILL_CATALOG_AND_DIRECTIVES_PROMPTFOO_REPORT) {
    return await readReport(process.env.SKILL_CATALOG_AND_DIRECTIVES_PROMPTFOO_REPORT);
  }

  const outDir = await mkdtemp(path.join(tmpdir(), "friday-promptfoo-skill-catalog-"));
  const reportPath = path.join(outDir, "skill-catalog-and-directives.json");
  const root = repoRoot();
  const script = path.join(root, "tools/qa/live-daemon/scenarios/skill-catalog-and-directives.ts");
  const args = ["run", "--allow-read", "--allow-env", "--allow-run", script, "--json-output", reportPath];

  const child = spawn("deno", args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  let report;
  try {
    report = await readReport(reportPath);
  } catch {
    throw new Error(
      `skill-catalog-and-directives runner did not produce ${reportPath}; exit=${exitCode}; stderr=${stderr}`,
    );
  }

  return { ...report, runnerExitCode: exitCode, runnerStdout: stdout, runnerStderr: stderr };
}

function reportOnce() {
  if (!reportPromise) reportPromise = runScenario();
  return reportPromise;
}

class SkillCatalogAndDirectivesProvider {
  id() {
    return "friday-skill-catalog-and-directives";
  }

  async callApi(prompt, context) {
    const scenarioId = context?.vars?.scenarioId || String(prompt).trim();
    const report = await reportOnce();
    const result = report.results.find((item) => item.id === scenarioId);
    const output = result ?? {
      id: scenarioId,
      pass: false,
      notes: [`scenario not found in skill-catalog-and-directives report: ${scenarioId}`],
      metrics: { availableIds: report.results.map((item) => item.id) },
    };
    return { output: JSON.stringify(output) };
  }
}

module.exports = SkillCatalogAndDirectivesProvider;
