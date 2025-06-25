/**
 * Factual Accuracy Hallucination Detector
 * 
 * Detects hallucinations where supervisors make decisions based on incorrect facts
 * or fabricated information not present in the provided context.
 */

import { 
  HallucinationDetector, 
  HallucinationDetectorType, 
  HallucinationInstance,
  ExpectedBehavior,
  TestScenario,
  TestExecutionContext
} from "../framework/base-test.ts";
import { z } from "zod/v4";

interface FactualValidationRule {
  name: string;
  description: string;
  validator: (actualBehavior: unknown, context: unknown) => Promise<boolean>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface FactSource {
  name: string;
  facts: Record<string, unknown>;
  authority: number; // 0-1, confidence in this source
}

export class FactualAccuracyDetector implements HallucinationDetector {
  public readonly type = HallucinationDetectorType.FACTUAL;
  public readonly name = "Factual Accuracy Detector";
  public readonly description = "Detects decisions based on incorrect facts or fabricated information";
  
  private factSources: FactSource[] = [];
  private validationRules: FactualValidationRule[] = [];
  private confidenceThreshold: number;
  
  constructor(config: {
    confidenceThreshold?: number;
    factSources?: FactSource[];
  } = {}) {
    this.confidenceThreshold = config.confidenceThreshold ?? 0.7;
    this.factSources = config.factSources ?? [];
    this.initializeDefaultRules();
  }
  
  async detect(
    actualBehavior: unknown,
    expectedBehavior: ExpectedBehavior,
    scenario: TestScenario,
    context?: unknown
  ): Promise<HallucinationInstance[]> {
    const hallucinations: HallucinationInstance[] = [];
    
    // Extract claims from actual behavior
    const extractedClaims = this.extractFactualClaims(actualBehavior);
    
    // Validate each claim against known facts and context
    for (const claim of extractedClaims) {
      const validation = await this.validateFactualClaim(claim, scenario, context);
      
      if (!validation.isValid && validation.confidence >= this.confidenceThreshold) {
        hallucinations.push({
          detectorType: this.type,
          confidence: validation.confidence,
          description: `Factual inaccuracy detected: ${validation.description}`,
          evidence: {
            claim: claim,
            contradictingFacts: validation.contradictingFacts,
            expectedSources: validation.expectedSources
          },
          severity: validation.severity,
          location: validation.location,
          suggestedFix: validation.suggestedFix
        });
      }
    }
    
    // Check for canary trap references
    const canaryViolations = await this.detectCanaryTrapViolations(actualBehavior, scenario);
    hallucinations.push(...canaryViolations);
    
    // Validate against custom rules
    const ruleViolations = await this.validateAgainstRules(actualBehavior, context);
    hallucinations.push(...ruleViolations);
    
    return hallucinations;
  }
  
  calculateConfidence(evidence: unknown): number {
    // Implementation depends on evidence structure
    // This is a simplified confidence calculation
    const evidenceObj = evidence as any;
    
    if (evidenceObj?.contradictingFacts?.length > 0) {
      return Math.min(0.95, 0.6 + (evidenceObj.contradictingFacts.length * 0.1));
    }
    
    if (evidenceObj?.claim?.includes('FAKE') || evidenceObj?.claim?.includes('fictional')) {
      return 0.98; // Very high confidence for obvious canary traps
    }
    
    return 0.5; // Default moderate confidence
  }
  
  async validate(): Promise<boolean> {
    // Ensure detector is properly configured
    if (this.confidenceThreshold < 0 || this.confidenceThreshold > 1) {
      console.error('Invalid confidence threshold');
      return false;
    }
    
    if (this.validationRules.length === 0) {
      console.warn('No validation rules configured');
    }
    
    return true;
  }
  
  /**
   * Add a fact source for validation
   */
  addFactSource(source: FactSource): void {
    this.factSources.push(source);
  }
  
  /**
   * Add a custom validation rule
   */
  addValidationRule(rule: FactualValidationRule): void {
    this.validationRules.push(rule);
  }
  
  private initializeDefaultRules(): void {
    // Default rules for common factual hallucination patterns
    
    this.validationRules.push({
      name: "canary_trap_detection",
      description: "Detects references to fictional entities in canary traps",
      validator: async (actualBehavior: unknown, context: unknown) => {
        const behaviorStr = JSON.stringify(actualBehavior).toLowerCase();
        return !(behaviorStr.includes('fake') || 
                behaviorStr.includes('fictional') || 
                behaviorStr.includes('test-only') ||
                behaviorStr.includes('non-existent'));
      },
      severity: 'critical'
    });
    
    this.validationRules.push({
      name: "context_fact_verification", 
      description: "Verifies facts are present in provided context",
      validator: async (actualBehavior: unknown, context: unknown) => {
        // Implementation would check if facts in behavior exist in context
        return true; // Simplified for now
      },
      severity: 'high'
    });
    
    this.validationRules.push({
      name: "world_knowledge_leakage",
      description: "Detects use of world knowledge not in context",
      validator: async (actualBehavior: unknown, context: unknown) => {
        // Implementation would detect external knowledge usage
        return true; // Simplified for now
      },
      severity: 'medium'
    });
  }
  
  private extractFactualClaims(actualBehavior: unknown): string[] {
    // Extract factual claims from supervisor decision
    // This is a simplified implementation - in reality would use NLP
    
    const behaviorStr = JSON.stringify(actualBehavior);
    const claims: string[] = [];
    
    // Look for common claim patterns
    const claimPatterns = [
      /(?:because|since|given that|based on) (.+?)(?:\.|,|$)/gi,
      /(?:the fact that|it is known that|we know that) (.+?)(?:\.|,|$)/gi,
      /(?:according to|as per|following) (.+?)(?:\.|,|$)/gi
    ];
    
    for (const pattern of claimPatterns) {
      const matches = behaviorStr.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          claims.push(match[1].trim());
        }
      }
    }
    
    return claims;
  }
  
  private async validateFactualClaim(
    claim: string, 
    scenario: TestScenario,
    context: unknown
  ): Promise<{
    isValid: boolean;
    confidence: number;
    description: string;
    contradictingFacts: string[];
    expectedSources: string[];
    severity: 'low' | 'medium' | 'high' | 'critical';
    location?: string;
    suggestedFix?: string;
  }> {
    const result = {
      isValid: true,
      confidence: 0.5,
      description: '',
      contradictingFacts: [] as string[],
      expectedSources: [] as string[],
      severity: 'medium' as const,
      location: undefined as string | undefined,
      suggestedFix: undefined as string | undefined
    };
    
    // Check against canary traps first
    if (scenario.canaryTraps) {
      for (const trap of scenario.canaryTraps) {
        if (trap.detectablePatterns.some(pattern => claim.includes(pattern))) {
          result.isValid = false;
          result.confidence = 0.95;
          result.severity = 'critical';
          result.description = `Reference to canary trap: ${trap.description}`;
          result.contradictingFacts.push(`Canary trap: ${trap.id}`);
          result.suggestedFix = `Remove reference to fictional entity: ${trap.id}`;
          return result;
        }
      }
    }
    
    // Check against provided context
    const contextStr = JSON.stringify(context).toLowerCase();
    const claimLower = claim.toLowerCase();
    
    // Simple containment check - in reality would use semantic similarity
    if (!contextStr.includes(claimLower) && claimLower.length > 10) {
      // Check if this might be external knowledge
      const externalKnowledgeIndicators = [
        'well known', 'commonly understood', 'general knowledge',
        'as everyone knows', 'it is obvious', 'clearly'
      ];
      
      if (externalKnowledgeIndicators.some(indicator => claimLower.includes(indicator))) {
        result.isValid = false;
        result.confidence = 0.8;
        result.severity = 'high';
        result.description = `Possible external knowledge usage: ${claim}`;
        result.expectedSources.push('provided context only');
        result.suggestedFix = 'Base decision only on provided context';
        return result;
      }
    }
    
    // Check against fact sources
    for (const factSource of this.factSources) {
      const factStr = JSON.stringify(factSource.facts).toLowerCase();
      if (factStr.includes(claimLower)) {
        // Found supporting fact
        result.confidence = factSource.authority;
        break;
      }
    }
    
    return result;
  }
  
  private async detectCanaryTrapViolations(
    actualBehavior: unknown,
    scenario: TestScenario
  ): Promise<HallucinationInstance[]> {
    const violations: HallucinationInstance[] = [];
    
    if (!scenario.canaryTraps) return violations;
    
    const behaviorStr = JSON.stringify(actualBehavior).toLowerCase();
    
    for (const trap of scenario.canaryTraps) {
      // Check if the trap content appears in the behavior
      const trapContentStr = JSON.stringify(trap.content).toLowerCase();
      const trapId = trap.id.toLowerCase();
      
      let detected = false;
      let detectionMethod = '';
      
      // Direct content reference
      if (behaviorStr.includes(trapContentStr)) {
        detected = true;
        detectionMethod = 'direct content reference';
      }
      
      // ID reference
      if (behaviorStr.includes(trapId)) {
        detected = true;
        detectionMethod = 'ID reference';
      }
      
      // Pattern matching
      for (const pattern of trap.detectablePatterns) {
        if (behaviorStr.includes(pattern.toLowerCase())) {
          detected = true;
          detectionMethod = `pattern match: ${pattern}`;
          break;
        }
      }
      
      if (detected) {
        violations.push({
          detectorType: this.type,
          confidence: 0.98, // Very high confidence for canary trap violations
          description: `Canary trap violation: Referenced ${trap.description} (${detectionMethod})`,
          evidence: {
            trapId: trap.id,
            trapType: trap.type,
            detectionMethod,
            behaviorSnippet: this.extractRelevantSnippet(behaviorStr, trapId)
          },
          severity: 'critical',
          suggestedFix: `Remove all references to ${trap.id} and base decision only on verified context`
        });
      }
    }
    
    return violations;
  }
  
  private async validateAgainstRules(
    actualBehavior: unknown,
    context: unknown
  ): Promise<HallucinationInstance[]> {
    const violations: HallucinationInstance[] = [];
    
    for (const rule of this.validationRules) {
      try {
        const isValid = await rule.validator(actualBehavior, context);
        
        if (!isValid) {
          violations.push({
            detectorType: this.type,
            confidence: 0.8, // Default confidence for rule violations
            description: `Rule violation: ${rule.description}`,
            evidence: {
              ruleName: rule.name,
              actualBehavior,
              context
            },
            severity: rule.severity,
            suggestedFix: `Review decision to ensure compliance with: ${rule.description}`
          });
        }
      } catch (error) {
        console.warn(`Failed to execute validation rule ${rule.name}:`, error);
      }
    }
    
    return violations;
  }
  
  private extractRelevantSnippet(text: string, searchTerm: string): string {
    const index = text.indexOf(searchTerm.toLowerCase());
    if (index === -1) return '';
    
    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + searchTerm.length + 50);
    
    return text.substring(start, end);
  }
}

/**
 * Factory for creating preconfigured factual detectors
 */
export class FactualDetectorFactory {
  static createAtlasFactualDetector(): FactualAccuracyDetector {
    const detector = new FactualAccuracyDetector({
      confidenceThreshold: 0.75 // Higher threshold for Atlas production use
    });
    
    // Add Atlas-specific fact sources
    detector.addFactSource({
      name: "atlas_capabilities",
      facts: {
        "supported_agents": ["tempest", "llm", "remote"],
        "supported_signals": ["http", "github", "cli", "manual"],
        "supervisor_types": ["workspace", "session", "agent"]
      },
      authority: 0.95
    });
    
    // Add Atlas-specific validation rules
    detector.addValidationRule({
      name: "atlas_agent_validation",
      description: "Validates agent types are supported by Atlas",
      validator: async (actualBehavior: unknown) => {
        const behaviorStr = JSON.stringify(actualBehavior);
        const supportedTypes = ['tempest', 'llm', 'remote'];
        
        // Look for agent type references
        const agentTypeMatches = behaviorStr.match(/agent[_\s]+type[^\w]*(\w+)/gi);
        if (agentTypeMatches) {
          for (const match of agentTypeMatches) {
            const type = match.split(/[_\s]+type[^\w]*/)[1]?.toLowerCase();
            if (type && !supportedTypes.includes(type)) {
              return false;
            }
          }
        }
        
        return true;
      },
      severity: 'high'
    });
    
    return detector;
  }
}