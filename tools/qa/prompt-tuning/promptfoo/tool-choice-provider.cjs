/**
 * promptfoo provider for the prompt-tuning tool-choice eval.
 *
 * On first call: spawns the deno scenario runner, which exercises the
 * workspace-chat prompt against a real Anthropic model with mock tool
 * captures, then writes a JSON report. Subsequent calls read the cached
 * report and look up the row for the requested scenarioId.
 *
 * The output JSON includes the assembled `systemPrompt` + `userMessage`
 * for each scenario so promptfoo can render them in the UI alongside the
 * pass/fail result.
 */

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

// Reports older than this in cached-mode trigger a warning so a forgotten
// env var doesn't silently report yesterday's pass/fail as today's.
const REPORT_FRESHNESS_THRESHOLD_MS = 10 * 60 * 1000;

async function runScenario() {
  const cachedReportPath = process.env.PROMPT_TUNING_TOOL_CHOICE_REPORT;
  if (cachedReportPath) {
    const report = await readReport(cachedReportPath);
    const startedAt = report?.startedAt ? new Date(report.startedAt) : null;
    if (startedAt && Number.isFinite(startedAt.getTime())) {
      const ageMs = Date.now() - startedAt.getTime();
      if (ageMs > REPORT_FRESHNESS_THRESHOLD_MS) {
        const ageMin = Math.round(ageMs / 60000);
        console.warn(
          `[tool-choice-provider] using cached report from ${report.startedAt} (${ageMin}m old). Re-run the deno scenario to refresh.`,
        );
      } else {
        console.log(`[tool-choice-provider] using cached report from ${report.startedAt}`);
      }
    } else {
      console.warn(
        `[tool-choice-provider] cached report at ${cachedReportPath} has no startedAt — cannot verify freshness.`,
      );
    }
    return report;
  }

  const outDir = await mkdtemp(path.join(tmpdir(), "friday-promptfoo-tool-choice-"));
  const reportPath = path.join(outDir, "tool-choice.json");
  const root = repoRoot();
  const script = path.join(root, "tools/qa/prompt-tuning/scenarios/tool-choice.ts");
  const args = ["run", "--allow-all", script, "--json-output", reportPath];

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
      `tool-choice runner did not produce ${reportPath}; exit=${exitCode}; stderr=${stderr}`,
    );
  }
  return { ...report, runnerExitCode: exitCode, runnerStdout: stdout, runnerStderr: stderr };
}

function reportOnce() {
  if (!reportPromise) reportPromise = runScenario();
  return reportPromise;
}

class ToolChoiceProvider {
  id() {
    return "friday-prompt-tuning-tool-choice";
  }

  async callApi(_prompt, context) {
    const scenarioId = context?.vars?.scenarioId;
    const report = await reportOnce();
    const result = report.results.find((item) => item.id === scenarioId);
    if (!result) {
      return {
        output: JSON.stringify({
          id: scenarioId,
          pass: false,
          notes: [`scenario not found in report: ${scenarioId}`],
          availableIds: report.results.map((r) => r.id),
        }),
      };
    }
    // promptfoo renders {{vars}} into `prompt` BEFORE the provider runs, so we
    // can't inject system_prompt / user_message from here back into the UI's
    // "Prompt" column. Instead, we surface them in the output JSON so they're
    // visible alongside pass/fail in the "Output" column. The static
    // prompt-template.txt body still appears in the UI's prompt column with
    // labels making the connection obvious.
    const outputBody = {
      id: result.id,
      pass: result.pass,
      notes: result.notes,
      capturedTools: result.capturedTools,
      systemPrompt: result.systemPrompt,
      userMessage: result.userMessage,
      assistantText: result.assistantText,
    };
    return {
      output: JSON.stringify(outputBody),
      metadata: { systemPrompt: result.systemPrompt, userMessage: result.userMessage },
    };
  }
}

module.exports = ToolChoiceProvider;
