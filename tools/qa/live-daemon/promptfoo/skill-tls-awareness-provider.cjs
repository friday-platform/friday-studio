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

async function runSkillTlsAwareness() {
  if (process.env.SKILL_TLS_AWARENESS_PROMPTFOO_REPORT) {
    return await readReport(process.env.SKILL_TLS_AWARENESS_PROMPTFOO_REPORT);
  }

  const outDir = await mkdtemp(path.join(tmpdir(), "friday-promptfoo-skill-tls-awareness-"));
  const reportPath = path.join(outDir, "skill-tls-awareness.json");
  const root = repoRoot();
  const script = path.join(root, "tools/qa/live-daemon/scenarios/skill-tls-awareness.ts");
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
      `skill-tls-awareness runner did not produce ${reportPath}; exit=${exitCode}; stderr=${stderr}`,
    );
  }

  return { ...report, runnerExitCode: exitCode, runnerStdout: stdout, runnerStderr: stderr };
}

function reportOnce() {
  if (!reportPromise) reportPromise = runSkillTlsAwareness();
  return reportPromise;
}

class SkillTlsAwarenessProvider {
  id() {
    return "friday-skill-tls-awareness";
  }

  async callApi(prompt, context) {
    const scenarioId = context?.vars?.scenarioId || String(prompt).trim();
    const report = await reportOnce();
    const result = report.results.find((item) => item.id === scenarioId);
    const output = result ?? {
      id: scenarioId,
      pass: false,
      notes: [`scenario not found in skill-tls-awareness report: ${scenarioId}`],
      metrics: { availableIds: report.results.map((item) => item.id) },
    };
    return { output: JSON.stringify(output) };
  }
}

module.exports = SkillTlsAwarenessProvider;
