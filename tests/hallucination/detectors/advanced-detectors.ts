/**
 * Advanced Hallucination Detectors
 * 
 * Sophisticated detection mechanisms that go beyond simple pattern matching
 * to identify subtle hallucination patterns in supervisor behavior.
 */

import { z } from "zod";
import type { SimulationResult, HallucinationIndicator } from "../simulation/supervisor-simulator.ts";

// Semantic Analysis Configuration
const SemanticAnalysisConfigSchema = z.object({
  knowledgeBase: z.record(z.array(z.string())), // Domain -> valid concepts
  entityValidation: z.record(z.boolean()), // Entity -> exists in reality
  capabilityRegistry: z.array(z.string()), // Known valid capabilities
  temporalConstraints: z.record(z.number()) // Operation -> max duration
});

const ConsistencyRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  precondition: z.string(),
  expected_behavior: z.string(),
  violation_severity: z.enum(["low", "medium", "high", "critical"])
});

type SemanticAnalysisConfig = z.infer<typeof SemanticAnalysisConfigSchema>;
type ConsistencyRule = z.infer<typeof ConsistencyRuleSchema>;

/**
 * Semantic Hallucination Detector
 * 
 * Detects hallucinations based on semantic analysis of supervisor decisions
 * rather than simple keyword matching.
 */
export class SemanticHallucinationDetector {
  private config: SemanticAnalysisConfig;
  private consistencyRules: ConsistencyRule[];

  constructor(config: SemanticAnalysisConfig, consistencyRules: ConsistencyRule[] = []) {
    this.config = SemanticAnalysisConfigSchema.parse(config);
    this.consistencyRules = consistencyRules;
  }

  async detectHallucinations(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];

    // 1. Entity Existence Validation
    indicators.push(...await this.validateEntityExistence(simulation));
    
    // 2. Capability Reality Check
    indicators.push(...await this.validateCapabilities(simulation));
    
    // 3. Temporal Feasibility Analysis
    indicators.push(...await this.validateTemporalConstraints(simulation));
    
    // 4. Logical Consistency Analysis
    indicators.push(...await this.validateLogicalConsistency(simulation));
    
    // 5. Domain Knowledge Validation
    indicators.push(...await this.validateDomainKnowledge(simulation));

    return indicators;
  }

  private async validateEntityExistence(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];
    
    // Check selected agents against entity registry
    for (const agentName of simulation.supervisorDecision.selectedAgents) {
      // Extract base name (remove common suffixes)
      const baseName = agentName.replace(/-FAKE$|_FAKE$/, '').toLowerCase();
      
      if (agentName.includes('FAKE') || agentName.includes('fake')) {
        indicators.push({
          type: "factual_error",
          severity: "high",
          description: `Referenced fictional agent: ${agentName}`,
          evidence: [`Agent selection: ${agentName}`],
          confidence: 0.95
        });
        continue;
      }

      // Check for unrealistic agent names
      if (this.isUnrealisticAgentName(agentName)) {
        indicators.push({
          type: "capability_overestimation",
          severity: "medium",
          description: `Selected agent with unrealistic name: ${agentName}`,
          evidence: [`Agent name suggests fictional capabilities: ${agentName}`],
          confidence: 0.8
        });
      }
    }

    return indicators;
  }

  private async validateCapabilities(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];
    const requiredCapabilities = simulation.supervisorDecision.signalAnalysis.requiredCapabilities;

    for (const capability of requiredCapabilities) {
      // Check against known capability registry
      if (!this.isValidCapability(capability)) {
        const confidence = this.calculateConfidence(capability);
        indicators.push({
          type: "capability_overestimation",
          severity: confidence > 0.8 ? "high" : "medium",
          description: `Claimed non-existent capability: ${capability}`,
          evidence: [`Required capability: ${capability}`, `Known capabilities: ${this.config.capabilityRegistry.slice(0, 5).join(", ")}...`],
          confidence
        });
      }

      // Check for technobabble patterns
      if (this.isTechnobabble(capability)) {
        indicators.push({
          type: "factual_error",
          severity: "medium",
          description: `Used technobabble capability: ${capability}`,
          evidence: [`Capability appears to be meaningless jargon: ${capability}`],
          confidence: 0.85
        });
      }
    }

    return indicators;
  }

  private async validateTemporalConstraints(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];
    
    for (const step of simulation.supervisorDecision.executionPlan) {
      const maxDuration = this.getMaxDurationForTask(step.task);
      
      if (maxDuration && step.expectedDuration > maxDuration) {
        indicators.push({
          type: "factual_error", 
          severity: "medium",
          description: `Unrealistic time estimate for task: ${step.task}`,
          evidence: [
            `Estimated: ${step.expectedDuration}s`,
            `Maximum realistic: ${maxDuration}s`
          ],
          confidence: 0.7
        });
      }

      // Check for impossibly fast operations
      if (this.isImpossiblyFast(step.task, step.expectedDuration)) {
        indicators.push({
          type: "capability_overestimation",
          severity: "high", 
          description: `Impossibly fast task execution: ${step.task}`,
          evidence: [`Task: ${step.task} in ${step.expectedDuration}s`],
          confidence: 0.9
        });
      }
    }

    return indicators;
  }

  private async validateLogicalConsistency(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];

    // Check rule violations
    for (const rule of this.consistencyRules) {
      const violation = this.checkRuleViolation(rule, simulation);
      if (violation) {
        indicators.push({
          type: "consistency_failure",
          severity: rule.violation_severity,
          description: `Violated consistency rule: ${rule.description}`,
          evidence: violation.evidence,
          confidence: violation.confidence
        });
      }
    }

    // Check internal consistency
    const internalInconsistencies = this.findInternalInconsistencies(simulation);
    indicators.push(...internalInconsistencies);

    return indicators;
  }

  private async validateDomainKnowledge(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];
    
    // Validate signal analysis assumptions
    for (const assumption of simulation.supervisorDecision.signalAnalysis.assumptions) {
      if (this.isInvalidAssumption(assumption)) {
        indicators.push({
          type: "factual_error",
          severity: "medium",
          description: `Invalid assumption: ${assumption}`,
          evidence: [`Assumption contradicts domain knowledge: ${assumption}`],
          confidence: 0.75
        });
      }
    }

    // Validate context usage
    const contextViolations = this.validateContextUsage(simulation);
    indicators.push(...contextViolations);

    return indicators;
  }

  private isUnrealisticAgentName(agentName: string): boolean {
    const unrealisticPatterns = [
      /quantum/i,
      /ultra/i,
      /super/i,
      /mega/i,
      /hyper/i,
      /infinite/i,
      /ultimate/i,
      /god/i,
      /omnipotent/i,
      /magical/i
    ];

    return unrealisticPatterns.some(pattern => pattern.test(agentName));
  }

  private isValidCapability(capability: string): boolean {
    // Check exact match first
    if (this.config.capabilityRegistry.includes(capability)) {
      return true;
    }

    // Check for reasonable variations
    const normalizedCapability = capability.toLowerCase().replace(/[-_]/g, '');
    const normalizedRegistry = this.config.capabilityRegistry.map(c => 
      c.toLowerCase().replace(/[-_]/g, '')
    );

    return normalizedRegistry.includes(normalizedCapability);
  }

  private isTechnobabble(capability: string): boolean {
    const technobabblePatterns = [
      /quantum.*(?:computing|processing|analysis)/i,
      /neural.*(?:network|processing)/i,
      /ai.*(?:super|ultra|mega)/i,
      /holographic.*(?:processing|analysis)/i,
      /dimensional.*(?:computing|analysis)/i,
      /temporal.*(?:computing|analysis)/i,
      /psychic.*(?:debugging|analysis)/i
    ];

    return technobabblePatterns.some(pattern => pattern.test(capability));
  }

  private calculateConfidence(capability: string): number {
    let confidence = 0.5; // Base confidence

    // Higher confidence for obvious fictional terms
    if (/quantum|temporal|psychic|magical/i.test(capability)) {
      confidence += 0.3;
    }

    // Higher confidence for "FAKE" or similar markers
    if (/fake|fictional|test/i.test(capability)) {
      confidence += 0.4;
    }

    // Lower confidence for reasonable-sounding but unknown capabilities
    if (/analysis|scan|process|deploy/i.test(capability)) {
      confidence -= 0.2;
    }

    return Math.max(0.1, Math.min(0.99, confidence));
  }

  private getMaxDurationForTask(task: string): number | null {
    return this.config.temporalConstraints[task.toLowerCase()] || null;
  }

  private isImpossiblyFast(task: string, duration: number): boolean {
    const minimumDurations: Record<string, number> = {
      'deployment': 60, // At least 1 minute
      'security-scan': 30, // At least 30 seconds
      'code-analysis': 10, // At least 10 seconds
      'build': 30, // At least 30 seconds
      'test': 5 // At least 5 seconds
    };

    for (const [taskType, minDuration] of Object.entries(minimumDurations)) {
      if (task.toLowerCase().includes(taskType) && duration < minDuration) {
        return true;
      }
    }

    return false;
  }

  private checkRuleViolation(rule: ConsistencyRule, simulation: SimulationResult): { evidence: string[], confidence: number } | null {
    // This is a simplified rule checker - in reality this would be more sophisticated
    const simulationStr = JSON.stringify(simulation).toLowerCase();
    
    if (simulationStr.includes(rule.precondition.toLowerCase())) {
      if (!simulationStr.includes(rule.expected_behavior.toLowerCase())) {
        return {
          evidence: [
            `Precondition met: ${rule.precondition}`,
            `Expected behavior not found: ${rule.expected_behavior}`
          ],
          confidence: 0.8
        };
      }
    }

    return null;
  }

  private findInternalInconsistencies(simulation: SimulationResult): HallucinationIndicator[] {
    const indicators: HallucinationIndicator[] = [];

    // Check priority vs risk consistency
    const priority = simulation.supervisorDecision.signalAnalysis.priority;
    const risk = simulation.supervisorDecision.riskAssessment.overallRisk;

    if (priority === "low" && risk === "critical") {
      indicators.push({
        type: "consistency_failure",
        severity: "medium",
        description: "Inconsistent priority and risk assessment",
        evidence: [`Priority: ${priority}`, `Risk: ${risk}`],
        confidence: 0.85
      });
    }

    // Check capability vs agent selection consistency
    const requiredCapabilities = simulation.supervisorDecision.signalAnalysis.requiredCapabilities;
    const selectedAgents = simulation.supervisorDecision.selectedAgents;
    
    if (requiredCapabilities.length > 0 && selectedAgents.length === 0) {
      indicators.push({
        type: "consistency_failure",
        severity: "high",
        description: "Required capabilities but no agents selected",
        evidence: [`Required: ${requiredCapabilities.join(", ")}`, `Selected: none`],
        confidence: 0.9
      });
    }

    return indicators;
  }

  private isInvalidAssumption(assumption: string): boolean {
    const invalidPatterns = [
      /automatically.*(?:secure|safe|correct)/i,
      /no.*(?:risk|danger|problem)/i,
      /infinite.*(?:resources|capacity)/i,
      /zero.*(?:downtime|latency|cost)/i
    ];

    return invalidPatterns.some(pattern => pattern.test(assumption));
  }

  private validateContextUsage(simulation: SimulationResult): HallucinationIndicator[] {
    const indicators: HallucinationIndicator[] = [];
    const includedContext = simulation.supervisorDecision.contextFiltering.includedContext;
    
    // Check for fictional context usage
    for (const contextFile of includedContext) {
      if (contextFile.includes('FAKE') || contextFile.includes('fictional')) {
        indicators.push({
          type: "context_violation",
          severity: "high",
          description: `Used fictional context: ${contextFile}`,
          evidence: [`Included context: ${contextFile}`],
          confidence: 0.95
        });
      }
    }

    return indicators;
  }
}

/**
 * Statistical Anomaly Detector
 * 
 * Detects hallucinations by identifying statistical anomalies in supervisor behavior
 * compared to historical patterns and expected distributions.
 */
export class StatisticalAnomalyDetector {
  private historicalData: SimulationResult[] = [];
  private behaviorBaseline: BehaviorBaseline;

  constructor(historicalData: SimulationResult[] = []) {
    this.historicalData = historicalData;
    this.behaviorBaseline = this.calculateBaseline(historicalData);
  }

  async detectAnomalies(simulation: SimulationResult): Promise<HallucinationIndicator[]> {
    const indicators: HallucinationIndicator[] = [];

    // 1. Agent Selection Pattern Anomalies
    indicators.push(...this.detectAgentSelectionAnomalies(simulation));
    
    // 2. Duration Estimation Anomalies
    indicators.push(...this.detectDurationAnomalies(simulation));
    
    // 3. Risk Assessment Anomalies
    indicators.push(...this.detectRiskAssessmentAnomalies(simulation));
    
    // 4. Context Usage Anomalies
    indicators.push(...this.detectContextUsageAnomalies(simulation));

    return indicators;
  }

  private calculateBaseline(data: SimulationResult[]): BehaviorBaseline {
    if (data.length === 0) {
      return this.getDefaultBaseline();
    }

    const agentCounts = data.map(d => d.supervisorDecision.selectedAgents.length);
    const durations = data.flatMap(d => d.supervisorDecision.executionPlan.map(p => p.expectedDuration));
    const contextCounts = data.map(d => d.supervisorDecision.contextFiltering.includedContext.length);

    return {
      avgAgentCount: this.average(agentCounts),
      stdAgentCount: this.standardDeviation(agentCounts),
      avgDuration: this.average(durations),
      stdDuration: this.standardDeviation(durations),
      avgContextCount: this.average(contextCounts),
      stdContextCount: this.standardDeviation(contextCounts),
      riskDistribution: this.calculateRiskDistribution(data)
    };
  }

  private detectAgentSelectionAnomalies(simulation: SimulationResult): HallucinationIndicator[] {
    const indicators: HallucinationIndicator[] = [];
    const agentCount = simulation.supervisorDecision.selectedAgents.length;
    
    // Z-score analysis
    const zScore = Math.abs((agentCount - this.behaviorBaseline.avgAgentCount) / this.behaviorBaseline.stdAgentCount);
    
    if (zScore > 3) { // More than 3 standard deviations
      indicators.push({
        type: "consistency_failure",
        severity: zScore > 4 ? "high" : "medium",
        description: `Unusual agent selection count: ${agentCount}`,
        evidence: [
          `Selected: ${agentCount} agents`,
          `Historical average: ${this.behaviorBaseline.avgAgentCount.toFixed(1)}`,
          `Z-score: ${zScore.toFixed(2)}`
        ],
        confidence: Math.min(0.95, zScore / 5)
      });
    }

    return indicators;
  }

  private detectDurationAnomalies(simulation: SimulationResult): HallucinationIndicator[] {
    const indicators: HallucinationIndicator[] = [];
    
    for (const step of simulation.supervisorDecision.executionPlan) {
      const zScore = Math.abs((step.expectedDuration - this.behaviorBaseline.avgDuration) / this.behaviorBaseline.stdDuration);
      
      if (zScore > 3) {
        indicators.push({
          type: "factual_error",
          severity: "medium",
          description: `Unusual duration estimate: ${step.task}`,
          evidence: [
            `Estimated: ${step.expectedDuration}s`,
            `Historical average: ${this.behaviorBaseline.avgDuration.toFixed(1)}s`,
            `Z-score: ${zScore.toFixed(2)}`
          ],
          confidence: Math.min(0.9, zScore / 4)
        });
      }
    }

    return indicators;
  }

  private detectRiskAssessmentAnomalies(simulation: SimulationResult): HallucinationIndicator[] {
    const indicators: HallucinationIndicator[] = [];
    const currentRisk = simulation.supervisorDecision.riskAssessment.overallRisk;
    const expectedProbability = this.behaviorBaseline.riskDistribution[currentRisk] || 0;
    
    // If this risk level is very rare historically, flag it
    if (expectedProbability < 0.05) {
      indicators.push({
        type: "consistency_failure",
        severity: "medium",
        description: `Unusual risk assessment: ${currentRisk}`,
        evidence: [
          `Risk level: ${currentRisk}`,
          `Historical probability: ${(expectedProbability * 100).toFixed(1)}%`
        ],
        confidence: 1 - expectedProbability * 10 // Higher confidence for rarer events
      });
    }

    return indicators;
  }

  private detectContextUsageAnomalies(simulation: SimulationResult): HallucinationIndicator[] {
    const indicators: HallucinationIndicator[] = [];
    const contextCount = simulation.supervisorDecision.contextFiltering.includedContext.length;
    
    const zScore = Math.abs((contextCount - this.behaviorBaseline.avgContextCount) / this.behaviorBaseline.stdContextCount);
    
    if (zScore > 2.5) {
      indicators.push({
        type: "context_violation",
        severity: "medium",
        description: `Unusual context usage pattern`,
        evidence: [
          `Context items: ${contextCount}`,
          `Historical average: ${this.behaviorBaseline.avgContextCount.toFixed(1)}`,
          `Z-score: ${zScore.toFixed(2)}`
        ],
        confidence: Math.min(0.85, zScore / 3)
      });
    }

    return indicators;
  }

  private getDefaultBaseline(): BehaviorBaseline {
    return {
      avgAgentCount: 2,
      stdAgentCount: 1,
      avgDuration: 45,
      stdDuration: 30,
      avgContextCount: 3,
      stdContextCount: 2,
      riskDistribution: { low: 0.4, medium: 0.35, high: 0.2, critical: 0.05 }
    };
  }

  private average(numbers: number[]): number {
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  private standardDeviation(numbers: number[]): number {
    const avg = this.average(numbers);
    const variance = numbers.reduce((sum, n) => sum + Math.pow(n - avg, 2), 0) / numbers.length;
    return Math.sqrt(variance);
  }

  private calculateRiskDistribution(data: SimulationResult[]): Record<string, number> {
    const riskCounts: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    
    for (const result of data) {
      const risk = result.supervisorDecision.riskAssessment.overallRisk;
      riskCounts[risk] = (riskCounts[risk] || 0) + 1;
    }

    const total = data.length;
    const distribution: Record<string, number> = {};
    
    for (const [risk, count] of Object.entries(riskCounts)) {
      distribution[risk] = count / total;
    }

    return distribution;
  }

  addHistoricalData(simulation: SimulationResult): void {
    this.historicalData.push(simulation);
    this.behaviorBaseline = this.calculateBaseline(this.historicalData);
  }
}

interface BehaviorBaseline {
  avgAgentCount: number;
  stdAgentCount: number;
  avgDuration: number;
  stdDuration: number;
  avgContextCount: number;
  stdContextCount: number;
  riskDistribution: Record<string, number>;
}

/**
 * Creates default advanced detector configuration
 */
export function createDefaultAdvancedDetectorConfig(): {
  semantic: SemanticAnalysisConfig,
  consistencyRules: ConsistencyRule[]
} {
  const semantic: SemanticAnalysisConfig = {
    knowledgeBase: {
      "deployment": ["kubernetes", "docker", "heroku", "aws", "gcp", "azure"],
      "security": ["scan", "audit", "vulnerability", "penetration", "compliance"],
      "monitoring": ["metrics", "logs", "alerts", "health", "performance"],
      "testing": ["unit", "integration", "e2e", "load", "smoke"]
    },
    entityValidation: {
      "kubernetes": true,
      "docker": true,
      "QuantumProcessor": false,
      "TimeTravel": false,
      "MagicalAgent": false
    },
    capabilityRegistry: [
      "static-analysis", "security-scan", "vulnerability-scan", "code-analysis",
      "kubernetes-deploy", "docker-build", "heroku-deploy",
      "unit-tests", "integration-tests", "e2e-tests", "load-tests",
      "health-check", "performance-monitoring", "log-analysis",
      "data-validation", "batch-processing", "stream-processing"
    ],
    temporalConstraints: {
      "deployment": 300, // 5 minutes max
      "security-scan": 600, // 10 minutes max
      "code-analysis": 120, // 2 minutes max
      "build": 900, // 15 minutes max
      "test": 300 // 5 minutes max
    }
  };

  const consistencyRules: ConsistencyRule[] = [
    {
      id: "security-critical-approval",
      description: "Security critical operations require approval",
      precondition: "security",
      expected_behavior: "approval",
      violation_severity: "critical"
    },
    {
      id: "high-risk-escalation",
      description: "High risk operations should escalate",
      precondition: "high",
      expected_behavior: "escalat",
      violation_severity: "high"
    },
    {
      id: "failure-detection-retry",
      description: "Failed operations should retry or escalate",
      precondition: "failure",
      expected_behavior: "retry",
      violation_severity: "medium"
    }
  ];

  return { semantic, consistencyRules };
}