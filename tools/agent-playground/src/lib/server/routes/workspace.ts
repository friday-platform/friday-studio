import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkspaceConfigSchema } from "@atlas/config";
import { logger as consoleLogger } from "@atlas/logger/console";
import {
  WorkspaceBlueprintSchema,
  type FSMDefinition,
  type WorkspaceBlueprint,
} from "@atlas/workspace-builder";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createSSEStream } from "../lib/sse.ts";
import {
  executeFSMs,
  runPipeline,
  type CompileResult,
  type ExecuteResult,
  type PipelineResult,
} from "../lib/workspace/pipeline.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNS_DIR = resolve(import.meta.dirname ?? ".", "../../../../runs/workspaces");

/** Known artifact files produced by the workspace pipeline. */
const ARTIFACT_FILES = [
  "input.json",
  "phase3.json",
  "fsm.json",
  "workspace.yml",
  "execution-report.json",
  "summary.txt",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a signal payload by populating each string property in the schema
 * with the user's raw input. Non-string properties are skipped.
 */
function buildSignalPayload(
  signalSchema: Record<string, unknown> | undefined,
  input: string,
): Record<string, unknown> {
  if (!signalSchema) return { input };
  const props = signalSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return { input };

  const payload: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop.type === "string") {
      payload[key] = input;
    }
  }
  return Object.keys(payload).length > 0 ? payload : { input };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function ensureRunsDir(): void {
  if (!existsSync(RUNS_DIR)) {
    mkdirSync(RUNS_DIR, { recursive: true });
  }
}

function createRunDir(slug: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dirName = `${timestamp}-${slug}`;
  const dir = join(RUNS_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Load all known artifact files from a run directory.
 * JSON files are parsed; text files returned as strings.
 */
function loadRunArtifacts(runDir: string): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const file of ARTIFACT_FILES) {
    const path = join(runDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      artifacts[file] = file.endsWith(".json") ? JSON.parse(content) : content;
    }
  }
  return artifacts;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ParseBody = z.object({ yaml: z.string().min(1) });

const SaveBody = z.object({ yaml: z.string().min(1), name: z.string().optional() });

const ExecuteBody = z.object({
  prompt: z.string().default(""),
  input: z.string().optional(),
  stopAt: z.enum(["plan", "fsm"]).optional(),
  real: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Workspace pipeline routes.
 *
 * - POST /parse    — validate a workspace.yml string, return parsed structure
 * - POST /execute  — run the full pipeline, stream SSE events
 * - GET  /runs     — list recent runs
 * - GET  /runs/:slug — load all artifacts for a specific run
 */
export const workspaceRoute = new Hono()
  // POST /parse — parse & validate workspace YAML
  .post("/parse", zValidator("json", ParseBody), (c) => {
    const { yaml } = c.req.valid("json");

    let parsed: unknown;
    try {
      parsed = parseYaml(yaml);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `YAML parse error: ${message}` }, 400);
    }

    const result = WorkspaceConfigSchema.safeParse(parsed);
    if (!result.success) {
      return c.json(
        {
          error: "Validation failed",
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }

    return c.json({ workspace: result.data });
  })

  // POST /save — persist a loaded workspace.yml to disk for history
  .post("/save", zValidator("json", SaveBody), (c) => {
    const { yaml, name } = c.req.valid("json");

    const slug = slugify(name || "loaded-workspace");
    ensureRunsDir();
    const runDir = createRunDir(slug);

    writeFileSync(join(runDir, "workspace.yml"), yaml);
    writeFileSync(
      join(runDir, "input.json"),
      JSON.stringify({ source: "loaded", name, timestamp: new Date().toISOString() }, null, 2),
    );
    writeFileSync(join(runDir, "summary.txt"), `Workspace: ${name || "(untitled)"}\n`);

    return c.json({ slug: runDir.split("/").pop() });
  })

  // POST /execute — run pipeline with SSE streaming
  .post("/execute", zValidator("json", ExecuteBody), (c) => {
    const { prompt, input, stopAt, real } = c.req.valid("json");

    return createSSEStream(async (emitter, signal) => {
      const slug = slugify(prompt);
      ensureRunsDir();
      const runDir = createRunDir(slug);

      // Save input metadata
      writeFileSync(
        join(runDir, "input.json"),
        JSON.stringify(
          { prompt, flags: { stopAt, real }, timestamp: new Date().toISOString() },
          null,
          2,
        ),
      );

      const startTime = performance.now();

      emitter.send("log", { message: "Starting pipeline...", phase: "init" });

      let pipelineResult: PipelineResult;
      try {
        pipelineResult = await runPipeline({
          prompt,
          input: input || undefined,
          logger: consoleLogger,
          stopAt,
          real,
          abortSignal: signal,
          onTransition: (transition) => {
            emitter.send("progress", { type: "state-transition", ...transition });
          },
          onAction: (action) => {
            emitter.send("progress", { type: "action-execution", ...action });
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeFileSync(join(runDir, "errors.json"), JSON.stringify({ error: message }, null, 2));
        throw err;
      }

      // Persist and emit blueprint
      const blueprint = pipelineResult.blueprint.blueprint;
      writeFileSync(join(runDir, "phase3.json"), JSON.stringify(blueprint, null, 2));
      emitter.send("artifact", { name: "blueprint", content: JSON.stringify(blueprint) });
      emitter.send("log", {
        message: `Blueprint: ${blueprint.workspace.name} (${blueprint.jobs.length} jobs)`,
        phase: "blueprint",
      });

      // Persist and emit compilation artifacts
      if (pipelineResult.compilation) {
        const compilation: CompileResult = pipelineResult.compilation;
        writeFileSync(join(runDir, "fsm.json"), JSON.stringify(compilation.fsms, null, 2));
        emitter.send("artifact", { name: "fsm", content: JSON.stringify(compilation.fsms) });
        emitter.send("log", {
          message: `Compiled ${compilation.fsms.length} FSM(s)`,
          phase: "compile",
        });
      }

      // Persist and emit workspace.yml
      if (pipelineResult.workspaceYaml) {
        writeFileSync(join(runDir, "workspace.yml"), pipelineResult.workspaceYaml);
        emitter.send("artifact", { name: "workspace.yml", content: pipelineResult.workspaceYaml });
      }

      // Persist execution report
      if (pipelineResult.execution) {
        const execution: ExecuteResult = pipelineResult.execution;
        writeFileSync(
          join(runDir, "execution-report.json"),
          JSON.stringify(execution.reports, null, 2),
        );
        emitter.send("artifact", {
          name: "execution-report",
          content: JSON.stringify(execution.reports),
        });
      }

      // Write summary
      const summaryLines = [
        `Workspace: ${blueprint.workspace.name}`,
        `Jobs: ${blueprint.jobs.length}`,
        `Signals: ${blueprint.signals.length}`,
        `Agents: ${blueprint.agents.length}`,
      ];
      writeFileSync(join(runDir, "summary.txt"), `${summaryLines.join("\n")}\n`);

      const durationMs = Math.round(performance.now() - startTime);
      const runSlug = runDir.split("/").pop() ?? "";
      emitter.send("done", { success: true, runPath: runDir, slug: runSlug, durationMs });
    });
  })

  // GET /runs — list recent workspace runs
  .get("/runs", (c) => {
    if (!existsSync(RUNS_DIR)) {
      return c.json({ runs: [] });
    }

    const runs = readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 30)
      .map((e) => {
        const runDir = join(RUNS_DIR, e.name);
        const summaryPath = join(runDir, "summary.txt");
        const summary = existsSync(summaryPath)
          ? (readFileSync(summaryPath, "utf-8").split("\n")[0] ?? "(no summary)")
          : "(no summary)";
        const hasErrors = existsSync(join(runDir, "errors.json"));

        let source: "loaded" | "generated" = "generated";
        const inputPath = join(runDir, "input.json");
        if (existsSync(inputPath)) {
          try {
            const input: unknown = JSON.parse(readFileSync(inputPath, "utf-8"));
            if (typeof input === "object" && input !== null && "source" in input && input.source === "loaded") source = "loaded";
          } catch {
            // ignore parse errors
          }
        }

        return { slug: e.name, summary, hasErrors, source };
      });

    return c.json({ runs });
  })

  // GET /runs/:slug — load artifacts for a specific run
  .get("/runs/:slug", (c) => {
    const slug = c.req.param("slug");
    const runDir = join(RUNS_DIR, slug);

    if (!existsSync(runDir)) {
      return c.json({ error: "Run not found" }, 404);
    }

    return c.json({ slug, artifacts: loadRunArtifacts(runDir) });
  })

  // POST /runs/:slug/execute — execute FSMs from a saved run (skip generation)
  .post(
    "/runs/:slug/execute",
    zValidator("json", z.object({ real: z.boolean().optional(), input: z.string().optional() })),
    (c) => {
      const slug = c.req.param("slug");
      const { real, input } = c.req.valid("json");
      const runDir = join(RUNS_DIR, slug);

      if (!existsSync(runDir)) {
        return c.json({ error: "Run not found" }, 404);
      }

      return createSSEStream(async (emitter) => {
        let plan: WorkspaceBlueprint;
        let fsms: FSMDefinition[];

        // Build signal payload from workspace.yml signal schema
        let signalPayload: Record<string, unknown> | undefined;
        if (input) {
          const ymlPath = join(runDir, "workspace.yml");
          if (existsSync(ymlPath)) {
            const yml = readFileSync(ymlPath, "utf-8");
            const wsConfig = WorkspaceConfigSchema.parse(parseYaml(yml));
            const firstSignal = Object.values(wsConfig.signals ?? {})[0];
            const schema = firstSignal?.schema as Record<string, unknown> | undefined;
            signalPayload = buildSignalPayload(schema, input);
          } else {
            signalPayload = { input };
          }
        }

        const blueprintPath = join(runDir, "phase3.json");
        const fsmPath = join(runDir, "fsm.json");

        if (existsSync(blueprintPath) && existsSync(fsmPath)) {
          // Generated run — use pre-compiled artifacts
          const rawPlan: unknown = JSON.parse(readFileSync(blueprintPath, "utf-8"));
          plan = WorkspaceBlueprintSchema.parse(rawPlan);
          const rawFsms: unknown = JSON.parse(readFileSync(fsmPath, "utf-8"));
          fsms = z
            .array(z.object({ id: z.string() }).passthrough())
            .parse(rawFsms) as unknown as FSMDefinition[];
        } else {
          // Loaded run — extract FSMs from workspace.yml and build minimal blueprint
          const ymlPath = join(runDir, "workspace.yml");
          if (!existsSync(ymlPath)) {
            throw new Error("Run has no workspace.yml, blueprint, or FSM artifacts");
          }
          const yml = readFileSync(ymlPath, "utf-8");
          const config = WorkspaceConfigSchema.parse(parseYaml(yml));

          // Extract embedded FSM definitions from jobs and build minimal
          // blueprint-shaped plan. executeFSMs needs plan.jobs[].triggerSignalId
          // for signal dispatch and documentContracts for mock schema stubs.
          fsms = [];
          const jobs: Array<{
            id: string;
            triggerSignalId: string;
            steps: unknown[];
            documentContracts: Array<{ documentId: string; schema: unknown }>;
          }> = [];
          for (const [jobId, job] of Object.entries(config.jobs ?? {})) {
            if (!job.fsm) continue;
            fsms.push(job.fsm);
            const idleState = job.fsm.states["idle"];
            const triggerSignalId = idleState?.on ? (Object.keys(idleState.on)[0] ?? jobId) : jobId;
            // Build document contracts by scanning actions for outputTo/outputType
            // pairs and resolving schemas from documentTypes. The mock executor
            // looks up stubs by outputTo (document instance ID), not outputType.
            const docTypes = job.fsm.documentTypes ?? {};
            const documentContracts: Array<{
              documentId: string;
              producerStepId: string;
              schema: unknown;
            }> = [];
            for (const [stateName, state] of Object.entries(job.fsm.states)) {
              if (!state || typeof state !== "object" || !("entry" in state)) continue;
              const entryActions = Array.isArray(state.entry) ? state.entry : [];
              for (const action of entryActions) {
                if (!action || typeof action !== "object") continue;
                const outputTo =
                  "outputTo" in action ? (action.outputTo as string | undefined) : undefined;
                const outputType =
                  "outputType" in action ? (action.outputType as string | undefined) : undefined;
                if (outputTo && outputType && docTypes[outputType]) {
                  // producerStepId: reverse the step_snake_case → kebab-case mapping
                  const stepId = stateName.replace(/^step_/, "").replace(/_/g, "-");
                  documentContracts.push({
                    documentId: outputTo,
                    producerStepId: stepId,
                    schema: docTypes[outputType],
                  });
                }
              }
            }
            jobs.push({ id: jobId, triggerSignalId, steps: [], documentContracts });
          }
          // Cast to WorkspaceBlueprint — mock executor tolerates missing fields
          plan = {
            workspace: { name: "", purpose: "" },
            signals: [],
            agents: [],
            jobs,
          } as unknown as WorkspaceBlueprint;

          // Persist FSMs for next time
          writeFileSync(fsmPath, JSON.stringify(fsms, null, 2));
        }

        const startTime = performance.now();
        emitter.send("log", { message: `Executing ${fsms.length} FSM(s)...`, phase: "execute" });

        const execution = await executeFSMs({
          plan,
          fsms,
          real,
          signalPayload,
          onTransition: (transition) => {
            emitter.send("progress", { type: "state-transition", ...transition });
          },
          onAction: (action) => {
            emitter.send("progress", { type: "action-execution", ...action });
          },
        });

        // Persist execution report
        writeFileSync(
          join(runDir, "execution-report.json"),
          JSON.stringify(execution.reports, null, 2),
        );
        emitter.send("artifact", {
          name: "execution-report",
          content: JSON.stringify(execution.reports),
        });

        const durationMs = Math.round(performance.now() - startTime);
        emitter.send("done", { success: true, slug, durationMs });
      });
    },
  );

