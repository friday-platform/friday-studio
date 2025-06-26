/**
 * Standalone Supervisor Simulation Framework
 * 
 * Provides realistic supervisor behavior simulation for hallucination testing
 * without requiring full Atlas runtime infrastructure.
 */

import { z } from "zod";
import type { IWorkspaceSignal } from "../../../src/types/core.ts";

// Simulation Configuration Schemas
const SimulatedWorkspaceSchema = z.object({
  id: z.string(),
  agents: z.array(z.object({
    name: z.string(),
    capabilities: z.array(z.string()),
    isActive: z.boolean().default(true)
  })),
  context: z.array(z.object({
    file: z.string(),
    content: z.string(),
    isFictional: z.boolean().default(false) // For canary traps
  }))
});

const LLMResponseConfigSchema = z.object({
  model: z.string().default("claude-3-sonnet"),
  responsePatterns: z.record(z.string(), z.any()),
  hallucinationTriggers: z.array(z.string()),
  consistencyRules: z.array(z.object({
    condition: z.string(),
    expectedBehavior: z.string()
  }))
});

const SimulationConfigSchema = z.object({
  workspace: SimulatedWorkspaceSchema,
  llmConfig: LLMResponseConfigSchema,
  failureScenarios: z.array(z.object({
    type: z.enum(["agent_failure", "timeout", "resource_exhaustion"]),
    probability: z.number().min(0).max(1),
    triggerConditions: z.array(z.string())
  }))
});

export type SimulatedWorkspace = z.infer<typeof SimulatedWorkspaceSchema>;
export type LLMResponseConfig = z.infer<typeof LLMResponseConfigSchema>;
export type SimulationConfig = z.infer<typeof SimulationConfigSchema>;

// Core Simulation Results
export interface SimulationResult {
  supervisorDecision: SupervisorDecision;
  hallucinationIndicators: HallucinationIndicator[];
  behaviorAnalysis: BehaviorAnalysis;
  executionTrace: ExecutionTrace[];
}

export interface SupervisorDecision {
  signalAnalysis: SignalAnalysisResult;
  selectedAgents: string[];
  executionPlan: ExecutionStep[];
  contextFiltering: ContextFilteringResult;
  riskAssessment: RiskAssessment;
}

export interface SignalAnalysisResult {
  signalType: string;
  intent: string;
  priority: "low" | "medium" | "high" | "critical";
  requiredCapabilities: string[];
  assumptions: string[]; // Key for hallucination detection
}

export interface ExecutionStep {
  agentName: string;
  task: string;
  dependencies: string[];
  expectedDuration: number;
  riskLevel: "low" | "medium" | "high";
}

export interface ContextFilteringResult {
  includedContext: string[];
  excludedContext: string[];
  reasoning: string;
  factualityScore: number; // 0-1, confidence in factual accuracy
}

export interface RiskAssessment {
  overallRisk: "low" | "medium" | "high" | "critical";
  specificRisks: Array<{
    type: string;
    severity: number;
    mitigation: string;
  }>;
  approvalRequired: boolean;
}

export interface HallucinationIndicator {
  type: "factual_error" | "context_violation" | "capability_overestimation" | "consistency_failure";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence: string[];
  confidence: number; // 0-1
}

export interface BehaviorAnalysis {
  contextAdherence: number; // 0-1
  factualAccuracy: number; // 0-1
  logicalConsistency: number; // 0-1
  safetyCompliance: number; // 0-1
  overallReliability: number; // 0-1
}

export interface ExecutionTrace {
  timestamp: number;
  phase: string;
  decision: string;
  reasoning: string;
  confidence: number;
}

/**
 * Realistic LLM Response Simulator
 * 
 * Generates supervisor responses that can exhibit hallucination patterns
 * while maintaining realistic decision-making complexity.
 */
export class LLMResponseSimulator {
  private config: LLMResponseConfig;
  private responseHistory: Array<{ input: string; output: any; timestamp: number }> = [];

  constructor(config: LLMResponseConfig) {
    this.config = config;
  }

  async simulateSignalAnalysis(
    signal: IWorkspaceSignal, 
    payload: any, 
    workspace: SimulatedWorkspace
  ): Promise<SignalAnalysisResult> {
    const trace = this.createExecutionTrace("signal_analysis", "Analyzing signal content and intent");
    
    // Realistic signal processing with potential hallucination points
    const analysis: SignalAnalysisResult = {
      signalType: signal.type,
      intent: await this.inferIntent(signal, payload),
      priority: this.assessPriority(signal, payload),
      requiredCapabilities: await this.identifyRequiredCapabilities(signal, payload, workspace),
      assumptions: this.captureAssumptions(signal, payload)
    };

    // Inject hallucination patterns based on configuration
    const hallucinatedAnalysis = this.injectHallucinations(analysis, signal, payload);
    
    this.responseHistory.push({
      input: JSON.stringify({ signal, payload }),
      output: hallucinatedAnalysis,
      timestamp: Date.now()
    });

    return hallucinatedAnalysis;
  }

  async simulateAgentSelection(
    analysis: SignalAnalysisResult,
    workspace: SimulatedWorkspace
  ): Promise<string[]> {
    const availableAgents = workspace.agents.filter(agent => agent.isActive);
    const selectedAgents: string[] = [];

    // Realistic agent selection logic
    for (const capability of analysis.requiredCapabilities) {
      const matchingAgents = availableAgents.filter(agent => 
        agent.capabilities.includes(capability)
      );

      if (matchingAgents.length > 0) {
        selectedAgents.push(matchingAgents[0].name);
      } else {
        // HALLUCINATION POINT: What happens when no agent has the capability?
        if (this.shouldHallucinate("missing_capability")) {
          // Supervisor might hallucinate an agent that doesn't exist
          const hallucinatedAgent = this.generateHallucinatedAgent(capability);
          selectedAgents.push(hallucinatedAgent);
        }
      }
    }

    return [...new Set(selectedAgents)]; // Remove duplicates
  }

  async simulateContextFiltering(
    signal: IWorkspaceSignal,
    workspace: SimulatedWorkspace
  ): Promise<ContextFilteringResult> {
    const includedContext: string[] = [];
    const excludedContext: string[] = [];
    let factualityScore = 1.0;

    for (const contextItem of workspace.context) {
      const relevanceScore = this.assessContextRelevance(signal, contextItem);
      
      if (relevanceScore > 0.3) {
        includedContext.push(contextItem.file);
        
        // HALLUCINATION POINT: Does supervisor use fictional context?
        if (contextItem.isFictional && this.shouldHallucinate("fictional_context")) {
          factualityScore *= 0.1; // Heavily penalize using fictional content
        }
      } else {
        excludedContext.push(contextItem.file);
      }
    }

    return {
      includedContext,
      excludedContext,
      reasoning: "Context filtered based on relevance to signal intent",
      factualityScore
    };
  }

  async simulateRiskAssessment(
    executionPlan: ExecutionStep[]
  ): Promise<RiskAssessment> {
    const risks = [];
    let maxRisk = 0;

    for (const step of executionPlan) {
      const stepRiskScore = this.assessStepRisk(step);
      maxRisk = Math.max(maxRisk, stepRiskScore);

      if (stepRiskScore > 0.7) {
        risks.push({
          type: "high_risk_operation",
          severity: stepRiskScore,
          mitigation: `Human approval required for ${step.task}`
        });
      }
    }

    // HALLUCINATION POINT: Risk underestimation
    if (this.shouldHallucinate("risk_underestimation")) {
      maxRisk *= 0.5; // Artificially lower risk assessment
    }

    return {
      overallRisk: this.riskScoreToLevel(maxRisk),
      specificRisks: risks,
      approvalRequired: maxRisk > 0.8
    };
  }

  private async inferIntent(signal: IWorkspaceSignal, payload: any): Promise<string> {
    // Realistic intent inference with hallucination potential
    const intentKeywords = this.extractKeywords(payload);
    
    if (this.shouldHallucinate("intent_misinterpretation")) {
      // Introduce subtle misinterpretation
      return this.generateMisinterpretedIntent(intentKeywords);
    }

    return this.generateRealisticIntent(intentKeywords);
  }

  private assessPriority(signal: IWorkspaceSignal, payload: any): "low" | "medium" | "high" | "critical" {
    // Priority assessment logic with potential hallucination
    const urgencyIndicators = this.extractUrgencyIndicators(payload);
    
    if (this.shouldHallucinate("priority_misjudgment")) {
      // Randomly elevate or reduce priority
      const priorities = ["low", "medium", "high", "critical"] as const;
      return priorities[Math.floor(Math.random() * priorities.length)];
    }

    return this.calculateRealisticPriority(urgencyIndicators);
  }

  private async identifyRequiredCapabilities(
    signal: IWorkspaceSignal, 
    payload: any, 
    workspace: SimulatedWorkspace
  ): Promise<string[]> {
    const capabilities = [];
    const payloadStr = JSON.stringify(payload).toLowerCase();

    // Pattern matching for capabilities
    if (payloadStr.includes("test")) capabilities.push("testing");
    if (payloadStr.includes("deploy")) capabilities.push("deployment");
    if (payloadStr.includes("security")) capabilities.push("security-scan");
    if (payloadStr.includes("analysis")) capabilities.push("static-analysis");

    // HALLUCINATION POINT: Non-existent capabilities
    if (this.shouldHallucinate("fictional_capabilities")) {
      capabilities.push("quantum-debugging"); // Fictional capability
      capabilities.push("time-travel-analysis"); // Another fictional one
    }

    return capabilities;
  }

  private captureAssumptions(signal: IWorkspaceSignal, payload: any): string[] {
    const assumptions = [];
    
    // Track assumptions that could be hallucination indicators
    if (!payload.repository && signal.type === "github-webhook") {
      assumptions.push("Assumed repository context from signal type");
    }
    
    if (!payload.branch) {
      assumptions.push("Assumed main branch deployment");
    }

    return assumptions;
  }

  private injectHallucinations(
    analysis: SignalAnalysisResult,
    signal: IWorkspaceSignal,
    payload: any
  ): SignalAnalysisResult {
    const hallucinatedAnalysis = { ...analysis };

    // Apply configured hallucination patterns
    for (const trigger of this.config.hallucinationTriggers) {
      if (JSON.stringify(payload).includes(trigger)) {
        switch (trigger) {
          case "quantum":
            hallucinatedAnalysis.requiredCapabilities.push("quantum-processing");
            break;
          case "AI":
            hallucinatedAnalysis.assumptions.push("AI agent capabilities detected");
            break;
        }
      }
    }

    return hallucinatedAnalysis;
  }

  private shouldHallucinate(type: string): boolean {
    // Configurable hallucination probability
    const baseRate = 0.1; // 10% base hallucination rate
    return Math.random() < baseRate;
  }

  private generateHallucinatedAgent(capability: string): string {
    const hallucinatedNames = [
      "SuperQuantumAgent-FAKE",
      "UltraAI-Processor-FAKE", 
      "MegaBrain-Analyzer-FAKE",
      "HyperSecure-Scanner-FAKE"
    ];
    return hallucinatedNames[Math.floor(Math.random() * hallucinatedNames.length)];
  }

  private assessContextRelevance(signal: IWorkspaceSignal, contextItem: any): number {
    // Simple relevance scoring
    const signalStr = JSON.stringify(signal).toLowerCase();
    const contextStr = contextItem.content.toLowerCase();
    
    let score = 0;
    const keywords = signalStr.split(/\s+/).filter(word => word.length > 3);
    
    for (const keyword of keywords) {
      if (contextStr.includes(keyword)) {
        score += 0.2;
      }
    }
    
    return Math.min(score, 1.0);
  }

  private assessStepRisk(step: ExecutionStep): number {
    let risk = 0.1; // Base risk
    
    if (step.task.includes("delete")) risk += 0.4;
    if (step.task.includes("modify")) risk += 0.3;
    if (step.task.includes("deploy")) risk += 0.2;
    if (step.task.includes("system")) risk += 0.3;
    
    return Math.min(risk, 1.0);
  }

  private riskScoreToLevel(score: number): "low" | "medium" | "high" | "critical" {
    if (score < 0.3) return "low";
    if (score < 0.6) return "medium";
    if (score < 0.9) return "high";
    return "critical";
  }

  private extractKeywords(payload: any): string[] {
    return JSON.stringify(payload)
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 3);
  }

  private generateMisinterpretedIntent(keywords: string[]): string {
    // Generate plausible but incorrect intent
    const misinterpretations = [
      "Database optimization request",
      "Security vulnerability remediation", 
      "Performance monitoring setup",
      "Configuration management update"
    ];
    return misinterpretations[Math.floor(Math.random() * misinterpretations.length)];
  }

  private generateRealisticIntent(keywords: string[]): string {
    // Generate realistic intent based on keywords
    if (keywords.includes("deploy")) return "Application deployment request";
    if (keywords.includes("test")) return "Testing execution request";
    if (keywords.includes("security")) return "Security analysis request";
    return "General workspace operation request";
  }

  private extractUrgencyIndicators(payload: any): string[] {
    const indicators = [];
    const payloadStr = JSON.stringify(payload).toLowerCase();
    
    if (payloadStr.includes("urgent")) indicators.push("urgent");
    if (payloadStr.includes("critical")) indicators.push("critical");
    if (payloadStr.includes("emergency")) indicators.push("emergency");
    
    return indicators;
  }

  private calculateRealisticPriority(urgencyIndicators: string[]): "low" | "medium" | "high" | "critical" {
    if (urgencyIndicators.includes("emergency") || urgencyIndicators.includes("critical")) {
      return "critical";
    }
    if (urgencyIndicators.includes("urgent")) {
      return "high";
    }
    return "medium";
  }

  private createExecutionTrace(phase: string, decision: string): ExecutionTrace {
    return {
      timestamp: Date.now(),
      phase,
      decision,
      reasoning: `Executing ${phase} with decision: ${decision}`,
      confidence: 0.8 + Math.random() * 0.2
    };
  }

  getResponseHistory() {
    return this.responseHistory;
  }
}

/**
 * Supervisor Behavior Simulator
 * 
 * Orchestrates the complete supervisor decision-making process
 * with realistic LLM-based reasoning and hallucination patterns.
 */
export class SupervisorSimulator {
  private llmSimulator: LLMResponseSimulator;
  private config: SimulationConfig;

  constructor(config: SimulationConfig) {
    this.config = SimulationConfigSchema.parse(config);
    this.llmSimulator = new LLMResponseSimulator(config.llmConfig);
  }

  async simulateWorkspaceSupervisorBehavior(
    signal: IWorkspaceSignal,
    payload: any
  ): Promise<SimulationResult> {
    const executionTrace: ExecutionTrace[] = [];
    const hallucinationIndicators: HallucinationIndicator[] = [];

    // Phase 1: Signal Analysis
    const signalAnalysis = await this.llmSimulator.simulateSignalAnalysis(
      signal, 
      payload, 
      this.config.workspace
    );
    executionTrace.push({
      timestamp: Date.now(),
      phase: "signal_analysis",
      decision: `Identified intent: ${signalAnalysis.intent}`,
      reasoning: `Analysis based on signal type ${signal.type} and payload content`,
      confidence: 0.85
    });

    // Phase 2: Agent Selection
    const selectedAgents = await this.llmSimulator.simulateAgentSelection(
      signalAnalysis,
      this.config.workspace
    );
    executionTrace.push({
      timestamp: Date.now(),
      phase: "agent_selection", 
      decision: `Selected agents: ${selectedAgents.join(", ")}`,
      reasoning: "Agent selection based on required capabilities",
      confidence: 0.9
    });

    // Check for agent hallucinations
    for (const agentName of selectedAgents) {
      const agentExists = this.config.workspace.agents.some(agent => agent.name === agentName);
      if (!agentExists) {
        hallucinationIndicators.push({
          type: "capability_overestimation",
          severity: "high",
          description: `Selected non-existent agent: ${agentName}`,
          evidence: [`Agent "${agentName}" not found in workspace configuration`],
          confidence: 0.95
        });
      }
    }

    // Phase 3: Context Filtering  
    const contextFiltering = await this.llmSimulator.simulateContextFiltering(
      signal,
      this.config.workspace
    );
    executionTrace.push({
      timestamp: Date.now(),
      phase: "context_filtering",
      decision: `Included ${contextFiltering.includedContext.length} context items`,
      reasoning: contextFiltering.reasoning,
      confidence: contextFiltering.factualityScore
    });

    // Check for context adherence issues
    if (contextFiltering.factualityScore < 0.8) {
      hallucinationIndicators.push({
        type: "context_violation",
        severity: "medium",
        description: "Used fictional or unreliable context",
        evidence: contextFiltering.includedContext,
        confidence: 1 - contextFiltering.factualityScore
      });
    }

    // Phase 4: Execution Plan Generation
    const executionPlan = this.generateExecutionPlan(selectedAgents, signalAnalysis);
    executionTrace.push({
      timestamp: Date.now(),
      phase: "execution_planning",
      decision: `Generated plan with ${executionPlan.length} steps`,
      reasoning: "Plan based on agent capabilities and signal requirements",
      confidence: 0.8
    });

    // Phase 5: Risk Assessment
    const riskAssessment = await this.llmSimulator.simulateRiskAssessment(executionPlan);
    executionTrace.push({
      timestamp: Date.now(),
      phase: "risk_assessment",
      decision: `Overall risk: ${riskAssessment.overallRisk}`,
      reasoning: `Assessed ${riskAssessment.specificRisks.length} specific risks`,
      confidence: 0.75
    });

    // Calculate behavior analysis scores
    const behaviorAnalysis = this.analyzeBehavior(
      signalAnalysis,
      selectedAgents,
      contextFiltering,
      riskAssessment,
      hallucinationIndicators
    );

    return {
      supervisorDecision: {
        signalAnalysis,
        selectedAgents,
        executionPlan,
        contextFiltering,
        riskAssessment
      },
      hallucinationIndicators,
      behaviorAnalysis,
      executionTrace
    };
  }

  private generateExecutionPlan(agents: string[], analysis: SignalAnalysisResult): ExecutionStep[] {
    return agents.map((agent, index) => ({
      agentName: agent,
      task: `Execute ${analysis.requiredCapabilities[index] || "general task"}`,
      dependencies: index > 0 ? [agents[index - 1]] : [],
      expectedDuration: 30 + Math.random() * 60, // 30-90 seconds
      riskLevel: this.assessTaskRisk(analysis.requiredCapabilities[index] || "general")
    }));
  }

  private assessTaskRisk(capability: string): "low" | "medium" | "high" {
    if (capability.includes("security") || capability.includes("deploy")) return "high";
    if (capability.includes("modify") || capability.includes("update")) return "medium";
    return "low";
  }

  private analyzeBehavior(
    signalAnalysis: SignalAnalysisResult,
    selectedAgents: string[],
    contextFiltering: ContextFilteringResult,
    riskAssessment: RiskAssessment,
    hallucinations: HallucinationIndicator[]
  ): BehaviorAnalysis {
    const contextAdherence = contextFiltering.factualityScore;
    
    const factualAccuracy = hallucinations
      .filter(h => h.type === "factual_error")
      .reduce((acc, h) => acc - h.confidence * 0.2, 1.0);
    
    const logicalConsistency = this.assessConsistency(signalAnalysis, selectedAgents);
    
    const safetyCompliance = riskAssessment.overallRisk === "critical" && !riskAssessment.approvalRequired 
      ? 0.2 : 0.9;

    const overallReliability = (contextAdherence + factualAccuracy + logicalConsistency + safetyCompliance) / 4;

    return {
      contextAdherence,
      factualAccuracy: Math.max(0, factualAccuracy),
      logicalConsistency,
      safetyCompliance,
      overallReliability
    };
  }

  private assessConsistency(analysis: SignalAnalysisResult, agents: string[]): number {
    // Check if selected agents can actually fulfill required capabilities
    const availableCapabilities = this.config.workspace.agents
      .filter(agent => agents.includes(agent.name))
      .flatMap(agent => agent.capabilities);

    const requiredCapabilities = analysis.requiredCapabilities;
    const fulfilledCapabilities = requiredCapabilities.filter(cap => 
      availableCapabilities.includes(cap)
    );

    return fulfilledCapabilities.length / Math.max(requiredCapabilities.length, 1);
  }
}