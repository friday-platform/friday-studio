import { join } from "@std/path";
import { exists } from "@std/fs";
import { logger } from "../../utils/logger.ts";
import type { JobSpecification } from "../session-supervisor.ts";

export interface WorkspacePlan {
  id: string;
  version: string;
  configHash: string;
  signalMappings: Map<string, PrecomputedExecution>;
  jobAnalysis: Map<string, JobAnalysis>;
  reasoningCache: Map<string, ReasoningResult>;
  createdAt: Date;
  lastUsed: Date;
}

export interface PrecomputedExecution {
  jobId: string;
  executionStrategy: "sequential" | "parallel" | "conditional" | "staged";
  agentChain: AgentExecutionPlan[];
  reasoningMethod: "cot" | "react" | "self-refine";
  estimatedDuration: number;
  confidence: number;
}

export interface AgentExecutionPlan {
  agentId: string;
  agentType: "tempest" | "llm" | "remote";
  prompt?: string;
  config?: Record<string, any>;
  expectedInputs: string[];
  expectedOutputs: string[];
}

export interface JobAnalysis {
  complexity: number; // 0-1 scale
  requiresToolUse: boolean;
  qualityCritical: boolean;
  parallelizable: boolean;
  dependencies: string[];
  riskFactors: string[];
}

export interface ReasoningResult {
  method: string;
  result: any;
  confidence: number;
  cost: number;
  duration: number;
}

export class WorkspacePlanningEngine {
  private planCache = new Map<string, WorkspacePlan>();
  private atlasDir: string;
  private logger = logger;

  constructor(workspaceRoot: string) {
    this.atlasDir = join(workspaceRoot, ".atlas");
  }

  async loadOrGeneratePlan(
    workspaceId: string,
    jobs: Record<string, JobSpecification>,
    signals: Record<string, any>,
  ): Promise<WorkspacePlan> {
    const configHash = await this.calculateConfigHash(jobs, signals);

    // Try to load existing plan
    const cachedPlan = await this.loadCachedPlan(workspaceId, configHash);
    if (cachedPlan) {
      this.logger.info("Using cached workspace plan", { workspaceId, configHash });
      cachedPlan.lastUsed = new Date();
      await this.persistPlan(cachedPlan);
      return cachedPlan;
    }

    // Generate new plan
    this.logger.info("Generating new workspace plan", { workspaceId, configHash });
    const plan = await this.generateWorkspacePlan(workspaceId, configHash, jobs, signals);
    await this.persistPlan(plan);

    return plan;
  }

  private async loadCachedPlan(
    workspaceId: string,
    configHash: string,
  ): Promise<WorkspacePlan | null> {
    try {
      const planPath = join(this.atlasDir, "plans", `workspace-${workspaceId}-plan.json`);

      if (!await exists(planPath)) {
        return null;
      }

      const planData = await Deno.readTextFile(planPath);
      const serializedPlan = JSON.parse(planData);

      // Check if config hash matches
      if (serializedPlan.configHash !== configHash) {
        this.logger.info("Plan cache invalidated due to config change", {
          workspaceId,
          oldHash: serializedPlan.configHash,
          newHash: configHash,
        });
        return null;
      }

      // Deserialize Maps
      const plan: WorkspacePlan = {
        ...serializedPlan,
        signalMappings: new Map(serializedPlan.signalMappings),
        jobAnalysis: new Map(serializedPlan.jobAnalysis),
        reasoningCache: new Map(serializedPlan.reasoningCache),
        createdAt: new Date(serializedPlan.createdAt),
        lastUsed: new Date(serializedPlan.lastUsed),
      };

      return plan;
    } catch (error) {
      this.logger.warn("Failed to load cached plan", { workspaceId, error: String(error) });
      return null;
    }
  }

  private async generateWorkspacePlan(
    workspaceId: string,
    configHash: string,
    jobs: Record<string, JobSpecification>,
    signals: Record<string, any>,
  ): Promise<WorkspacePlan> {
    const plan: WorkspacePlan = {
      id: workspaceId,
      version: "1.0",
      configHash,
      signalMappings: new Map(),
      jobAnalysis: new Map(),
      reasoningCache: new Map(),
      createdAt: new Date(),
      lastUsed: new Date(),
    };

    // Analyze each job
    for (const [jobId, jobSpec] of Object.entries(jobs)) {
      const analysis = await this.analyzeJob(jobSpec);
      plan.jobAnalysis.set(jobId, analysis);

      // Create execution plan for each job
      const executionPlan = await this.createExecutionPlan(jobSpec, analysis);

      // Map signals to execution plans
      if (jobSpec.triggers) {
        for (const trigger of jobSpec.triggers) {
          plan.signalMappings.set(trigger.signal, executionPlan);
        }
      }
    }

    return plan;
  }

  private async analyzeJob(jobSpec: JobSpecification): Promise<JobAnalysis> {
    // Calculate complexity based on agent count, strategy, and description
    const agentCount = jobSpec.execution.agents.length;
    const strategyComplexity = {
      "sequential": 0.1,
      "parallel": 0.3,
      "conditional": 0.5,
      "staged": 0.7,
    }[jobSpec.execution.strategy] || 0.3;

    const descriptionComplexity = jobSpec.description.length > 200 ? 0.2 : 0.05;
    const complexity = Math.min(
      1.0,
      (agentCount * 0.15) + strategyComplexity + descriptionComplexity,
    );

    // Analyze requirements
    const requiresToolUse = jobSpec.description.toLowerCase().includes("tool") ||
      jobSpec.description.toLowerCase().includes("api") ||
      jobSpec.description.toLowerCase().includes("file");

    const qualityCritical = jobSpec.description.toLowerCase().includes("security") ||
      jobSpec.description.toLowerCase().includes("critical") ||
      jobSpec.description.toLowerCase().includes("production");

    const parallelizable = jobSpec.execution.strategy === "parallel" ||
      jobSpec.execution.strategy === "staged";

    return {
      complexity,
      requiresToolUse,
      qualityCritical,
      parallelizable,
      dependencies: [], // TODO: Extract from job spec
      riskFactors: qualityCritical ? ["security-critical"] : [],
    };
  }

  private async createExecutionPlan(
    jobSpec: JobSpecification,
    analysis: JobAnalysis,
  ): Promise<PrecomputedExecution> {
    // Select reasoning method based on analysis (priority order matters)
    let reasoningMethod: "cot" | "react" | "self-refine" = "cot";

    if (analysis.qualityCritical) {
      reasoningMethod = "self-refine"; // Quality critical overrides everything
    } else if (analysis.requiresToolUse) {
      reasoningMethod = "react"; // Tool use gets ReAct
    }

    // Create agent execution plans
    const agentChain: AgentExecutionPlan[] = jobSpec.execution.agents.map((agent) => ({
      agentId: typeof agent === "string" ? agent : agent.id,
      agentType: "llm", // TODO: Determine from agent config
      prompt: typeof agent === "object" ? agent.prompt : undefined,
      config: typeof agent === "object" ? agent.config : undefined,
      expectedInputs: ["previous_output", "signal_payload"],
      expectedOutputs: ["processed_result"],
    }));

    // Estimate duration (rough heuristic)
    const baseTime = 30; // 30 seconds base
    const complexityMultiplier = 1 + analysis.complexity;
    const agentMultiplier = jobSpec.execution.strategy === "parallel"
      ? 1.2
      : jobSpec.execution.agents.length;
    const estimatedDuration = Math.round(baseTime * complexityMultiplier * agentMultiplier);

    return {
      jobId: jobSpec.name,
      executionStrategy: jobSpec.execution.strategy,
      agentChain,
      reasoningMethod,
      estimatedDuration,
      confidence: 1.0 - (analysis.complexity * 0.3), // Higher complexity = lower confidence
    };
  }

  private async calculateConfigHash(
    jobs: Record<string, JobSpecification>,
    signals: Record<string, any>,
  ): Promise<string> {
    const configString = JSON.stringify({ jobs, signals }, null, 0);
    const encoder = new TextEncoder();
    const data = encoder.encode(configString);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async persistPlan(plan: WorkspacePlan): Promise<void> {
    try {
      const plansDir = join(this.atlasDir, "plans");
      await Deno.mkdir(plansDir, { recursive: true });

      const planPath = join(plansDir, `workspace-${plan.id}-plan.json`);

      // Serialize Maps for JSON storage
      const serializedPlan = {
        ...plan,
        signalMappings: Array.from(plan.signalMappings.entries()),
        jobAnalysis: Array.from(plan.jobAnalysis.entries()),
        reasoningCache: Array.from(plan.reasoningCache.entries()),
        createdAt: plan.createdAt.toISOString(),
        lastUsed: plan.lastUsed.toISOString(),
      };

      await Deno.writeTextFile(planPath, JSON.stringify(serializedPlan, null, 2));

      this.logger.info("Persisted workspace plan", { workspaceId: plan.id, planPath });
    } catch (error) {
      this.logger.error("Failed to persist workspace plan", {
        workspaceId: plan.id,
        error: String(error),
      });
    }
  }

  async invalidateCache(workspaceId: string): Promise<void> {
    try {
      const planPath = join(this.atlasDir, "plans", `workspace-${workspaceId}-plan.json`);
      if (await exists(planPath)) {
        await Deno.remove(planPath);
        this.logger.info("Invalidated workspace plan cache", { workspaceId });
      }
    } catch (error) {
      this.logger.warn("Failed to invalidate cache", { workspaceId, error: String(error) });
    }
  }
}
