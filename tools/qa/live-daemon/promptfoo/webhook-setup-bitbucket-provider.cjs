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
  const cachedReportPath = process.env.WEBHOOK_SETUP_BITBUCKET_PROMPTFOO_REPORT;
  if (cachedReportPath) {
    // Loud-by-default: a "promptfoo eval green" PR check that's actually
    // replaying a stale report would otherwise look identical to a fresh run.
    process.stderr.write(
      `[webhook-setup-bitbucket-provider] REPLAYING cached report from ${cachedReportPath} (set via WEBHOOK_SETUP_BITBUCKET_PROMPTFOO_REPORT). The eval was NOT re-run for this invocation.\n`,
    );
    return await readReport(cachedReportPath);
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
      `webhook-setup-bitbucket runner did not produce ${reportPath}; exit=${exitCode}; stderr=${stderr}`,
    );
  }

  return { ...report, runnerExitCode: exitCode, runnerStdout: stdout, runnerStderr: stderr };
}

function reportOnce() {
  if (!reportPromise) reportPromise = runWebhookSetupBitbucket();
  return reportPromise;
}

class WebhookSetupBitbucketProvider {
  id() {
    return "friday-webhook-setup-bitbucket";
  }

  async callApi(prompt, context) {
    const scenarioId = context?.vars?.scenarioId || String(prompt).trim();
    const report = await reportOnce();
    const result = report.results.find((item) => item.id === scenarioId);
    const output = result ?? {
      id: scenarioId,
      pass: false,
      notes: [`scenario not found in webhook-setup-bitbucket report: ${scenarioId}`],
      metrics: { availableIds: report.results.map((item) => item.id) },
    };
    return { output: JSON.stringify(output) };
  }
}

module.exports = WebhookSetupBitbucketProvider;
