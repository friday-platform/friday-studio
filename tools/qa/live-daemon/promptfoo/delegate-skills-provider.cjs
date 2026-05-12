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

async function runDelegateSkills() {
  if (process.env.DELEGATE_SKILLS_PROMPTFOO_REPORT) {
    return await readReport(process.env.DELEGATE_SKILLS_PROMPTFOO_REPORT);
  }

  const outDir = await mkdtemp(path.join(tmpdir(), "friday-promptfoo-delegate-skills-"));
  const reportPath = path.join(outDir, "delegate-skills.json");
  const root = repoRoot();
  const script = path.join(root, "tools/qa/live-daemon/scenarios/delegate-skills.ts");
  const args = [
    "run",
    "--allow-all",
    "--unstable-worker-options",
    "--unstable-kv",
    "--unstable-raw-imports",
    script,
    "--json-output",
    reportPath,
  ];

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
      `delegate-skills runner did not produce ${reportPath}; exit=${exitCode}; stderr=${stderr}`,
    );
  }

  return { ...report, runnerExitCode: exitCode, runnerStdout: stdout, runnerStderr: stderr };
}

function reportOnce() {
  if (!reportPromise) reportPromise = runDelegateSkills();
  return reportPromise;
}

class DelegateSkillsProvider {
  id() {
    return "friday-delegate-skills";
  }

  async callApi(prompt, context) {
    const scenarioId = context?.vars?.scenarioId || String(prompt).trim();
    const report = await reportOnce();
    const result = report.results.find((item) => item.id === scenarioId);
    const output = result ?? {
      id: scenarioId,
      pass: false,
      notes: [`scenario not found in delegate-skills report: ${scenarioId}`],
      metrics: { availableIds: report.results.map((item) => item.id) },
    };
    return { output: JSON.stringify(output) };
  }
}

module.exports = DelegateSkillsProvider;
