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

async function runWebhookSetupBitbucket() {
  if (process.env.WEBHOOK_SETUP_BITBUCKET_PROMPTFOO_REPORT) {
    return await readReport(process.env.WEBHOOK_SETUP_BITBUCKET_PROMPTFOO_REPORT);
  }

  const outDir = await mkdtemp(path.join(tmpdir(), "friday-promptfoo-webhook-setup-bitbucket-"));
  const reportPath = path.join(outDir, "webhook-setup-bitbucket.json");
  const root = repoRoot();
  const script = path.join(root, "tools/qa/live-daemon/scenarios/webhook-setup-bitbucket.ts");
  const args = [
    "run",
    "--allow-all",
    "--unstable-worker-options",
    "--unstable-kv",
    "--unstable-raw-imports",
    "--env-file",
    script,
    "--json-output",
    reportPath,
  ];

  await new Promise((resolve, reject) => {
    const proc = spawn("deno", args, {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      // The scenario exits non-zero when any case fails — that's still a
      // valid report. Treat spawn errors as fatal, exit code as data.
      resolve(code ?? 0);
    });
  });

  return await readReport(reportPath);
}

function ensureReport() {
  if (!reportPromise) {
    reportPromise = runWebhookSetupBitbucket();
  }
  return reportPromise;
}

module.exports = {
  async callApi(prompt) {
    const report = await ensureReport();
    const scenarioId = String(prompt).trim();
    const result = report.results.find((r) => r.id === scenarioId);
    if (!result) {
      return {
        output: JSON.stringify({
          id: scenarioId,
          pass: false,
          notes: [
            `scenario id not found in report; available: ${report.results.map((r) => r.id).join(", ")}`,
          ],
          metrics: {},
        }),
      };
    }
    return { output: JSON.stringify(result) };
  },
};
