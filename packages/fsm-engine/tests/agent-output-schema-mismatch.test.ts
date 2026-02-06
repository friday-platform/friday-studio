/**
 * Regression test: bundled agent output schema mismatch.
 *
 * Calls flattenAgent → generateFSMCode (real LLM) → executes code → runs FSM
 * with mock agents returning real production output shapes.
 *
 * On main branch: flattenAgent does NOT populate outputSchema → LLM has no
 * knowledge of agent output shape → hallucinates fields → FSM fails.
 *
 * On this branch: flattenAgent populates outputSchema from registry → LLM
 * sees exact field names → generates correct code → FSM succeeds.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { AgentExecutionSuccess, AgentResult } from "@atlas/agent-sdk";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { fetchCredentials, setToEnv } from "@atlas/core/credentials";
import { InMemoryDocumentStore } from "@atlas/document-store";
import { classifyAgents } from "@atlas/system/agents/fsm-workspace-creator/agent-classifier";
import { flattenAgent } from "@atlas/system/agents/fsm-workspace-creator/agent-helpers";
import { generateFSMCode } from "@atlas/system/agents/fsm-workspace-creator/fsm-generation-core";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { BuildError, Result } from "@atlas/workspace-builder";
import {
  agentAction,
  codeAction,
  emitAction,
  FSMBuilder,
  llmAction,
} from "@atlas/workspace-builder";
import dotenv from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import { FSMEngine } from "../fsm-engine.ts";
import type {
  AgentAction,
  Context,
  FSMDefinition,
  LLMProvider,
  SignalWithContext,
} from "../types.ts";

const plan: WorkspacePlan = {
  workspace: {
    name: "Research and Summarize",
    purpose: "Research a topic on the web and then summarize the findings",
  },
  signals: [
    {
      id: "start-research",
      name: "Start Research",
      title: "Triggers research pipeline",
      signalType: "http",
      description: "Research SpaceX latest news and produce a summary",
    },
  ],
  agents: [
    {
      id: "web-researcher",
      name: "Web Researcher",
      description:
        "Searches the web for information on a given topic and produces a research report",
      needs: ["research"],
      configuration: {},
    },
    {
      id: "summary-writer",
      name: "Summary Writer",
      description: "Takes research findings and composes a concise executive summary",
      needs: ["get-summary"],
      configuration: {},
    },
  ],
  jobs: [
    {
      id: "research-and-summarize",
      name: "Research and Summarize",
      title: "Research and Summarize",
      triggerSignalId: "start-research",
      steps: [
        {
          agentId: "web-researcher",
          description: "Search the web for the latest SpaceX news and produce a research report",
        },
        {
          agentId: "summary-writer",
          description: "Summarize the research findings into a concise executive summary",
        },
      ],
      behavior: "sequential",
    },
  ],
};

/** Real research agent output shape from production */
function mockResearchAgentResult(agentId: string): AgentResult {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: "Search the web for the latest news about SpaceX",
    ok: true,
    data: {
      summary: "SpaceX is targeting mid-March 2026 for the debut launch of Starship V3.",
      artifactRef: {
        id: "f223fe95-d52a-40a8-a8ba-1b70b96388a3",
        type: "web-search",
        summary: "SpaceX latest news report",
      },
      outlineRefs: [
        {
          service: "internal",
          title: "Search Result",
          content: "Latest SpaceX News Updates",
          artifactId: "f223fe95-d52a-40a8-a8ba-1b70b96388a3",
          artifactLabel: "View Report",
          type: "web-search",
        },
      ],
    },
    durationMs: 5000,
  };
}

function mockSummaryAgentResult(agentId: string): AgentResult {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: "Summarize SpaceX research",
    ok: true,
    data: { response: "Summary of SpaceX research" },
    artifactRefs: [
      { id: "summary-artifact", type: "summary", summary: "SpaceX Starship V3 summary" },
    ],
    durationMs: 1000,
  };
}

function executeFSMCode(code: string): Result<FSMDefinition, BuildError[]> {
  let cleanCode = code.trim();
  if (cleanCode.startsWith("```")) {
    const firstNewline = cleanCode.indexOf("\n");
    if (firstNewline !== -1) cleanCode = cleanCode.substring(firstNewline + 1);
  }
  if (cleanCode.endsWith("```")) {
    cleanCode = cleanCode.substring(0, cleanCode.length - 3).trim();
  }

  const fn = new Function(
    "FSMBuilder",
    "agentAction",
    "codeAction",
    "emitAction",
    "llmAction",
    cleanCode +
      "\n\nif (typeof result === 'undefined') {\n" +
      "  throw new Error(\"Code must set 'result' variable to builder.build() output.\");\n" +
      "}\nreturn result;",
  );

  return fn(FSMBuilder, agentAction, codeAction, emitAction, llmAction) as Result<
    FSMDefinition,
    BuildError[]
  >;
}

function findFinalStateName(fsm: FSMDefinition): string {
  const entry = Object.entries(fsm.states).find(([, s]) => s.type === "final");
  if (!entry) throw new Error("FSM has no final state");
  return entry[0];
}

async function driveFSM(fsm: FSMDefinition, triggerSignalId: string): Promise<string> {
  const store = new InMemoryDocumentStore();
  const scope = { workspaceId: "test", sessionId: `test-${Date.now()}` };

  const agentExecutor = (
    action: AgentAction,
    _context: Context,
    _signal: SignalWithContext,
  ): Promise<AgentResult> => {
    const { agentId } = action;
    if (agentId === "research") return Promise.resolve(mockResearchAgentResult(agentId));
    if (agentId === "get-summary") return Promise.resolve(mockSummaryAgentResult(agentId));
    throw new Error(`Unexpected agent: ${agentId}`);
  };

  const mockLLMProvider: LLMProvider = {
    call: (params) => {
      const startMs = Date.now();
      return Promise.resolve({
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: true,
        data: { response: "Mock LLM response" },
        durationMs: Date.now() - startMs,
      } satisfies AgentExecutionSuccess);
    },
  };

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    agentExecutor,
    llmProvider: mockLLMProvider,
  });
  await engine.initialize();

  const finalStateName = findFinalStateName(fsm);

  await engine.signal({ type: triggerSignalId });

  for (let step = 0; step < 20 && engine.state !== finalStateName; step++) {
    const emitted = engine.emittedEvents;
    if (emitted.length > 0) {
      for (const ev of emitted) {
        await engine.signal({ type: ev.event, data: ev.data });
      }
      continue;
    }
    await engine.signal({ type: "ADVANCE" });
  }

  return engine.state;
}

const isCI = !!process.env.CI;

describe.skipIf(isCI)("bundled agent output schema mismatch (regression)", () => {
  beforeAll(async () => {
    dotenv.config();
    const globalAtlasEnv = join(getAtlasHome(), ".env");
    if (existsSync(globalAtlasEnv)) {
      dotenv.config({ path: globalAtlasEnv, override: true });
    }
    const atlasKey = process.env.ATLAS_KEY;
    if (!atlasKey) throw new Error("ATLAS_KEY environment variable is not set");
    const credentials = await fetchCredentials({ atlasKey, retries: 3, retryDelay: 2000 });
    setToEnv(credentials);
  });

  it("LLM-generated FSM runs to completion with real agent output shapes", async () => {
    const [job] = plan.jobs;
    if (!job) throw new Error("Expected at least one job in plan");
    const signal = plan.signals.find(
      (s: WorkspacePlan["signals"][number]) => s.id === job.triggerSignalId,
    );
    if (!signal) throw new Error(`Expected signal for job trigger ${job.triggerSignalId}`);

    // flattenAgent: on main → no outputSchema; on this branch → outputSchema populated
    const classified = classifyAgents(plan);
    const agents = classified
      .filter((a) =>
        job.steps.some((s: WorkspacePlan["jobs"][number]["steps"][number]) => s.agentId === a.id),
      )
      .map(flattenAgent);

    // The fix: flattenAgent must populate outputSchema from the bundled agent registry.
    // On main branch this field is undefined → LLM has no knowledge of agent output shape.
    const bundledAgents = agents.filter((a) => a.executionType === "bundled");
    expect(bundledAgents.length).toBeGreaterThan(0);
    for (const agent of bundledAgents) {
      expect(agent.outputSchema, `${agent.id} should have outputSchema populated`).toBeDefined();
    }

    // Generate FSM code via real LLM
    const code = await generateFSMCode(job, agents, signal);

    // Execute generated code
    const buildResult = executeFSMCode(code);
    expect(buildResult.success).toBe(true);
    if (!buildResult.success) {
      const errors = buildResult.error.map((e: BuildError) => `${e.type}: ${e.message}`).join("\n");
      throw new Error(`FSM build failed:\n${errors}`);
    }

    // Run FSM with mock agents returning real production output shapes
    const fsm = buildResult.value;
    const finalState = await driveFSM(fsm, signal.id);

    expect(finalState).toBe(findFinalStateName(fsm));
  }, 120_000);
});
