/**
 * Context Adherence Hallucination Detector
 * 
 * Detects hallucinations where supervisors use external world knowledge
 * instead of provided context, or misinterpret the given context.
 */

import { 
  HallucinationDetector, 
  HallucinationDetectorType, 
  HallucinationInstance,
  ExpectedBehavior,
  TestScenario,
  TestExecutionContext
} from "../framework/base-test.ts";

interface ContextSource {
  name: string;
  content: unknown;
  priority: number; // Higher priority sources should be referenced first
  required: boolean; // Must be referenced in decision
}

interface ContextReference {
  source: string;
  content: string;
  confidence: number;
  isDirectQuote: boolean;
  isParaphrase: boolean;
  isImplied: boolean;
}

export class ContextAdherenceDetector implements HallucinationDetector {
  public readonly type = HallucinationDetectorType.CONTEXT;
  public readonly name = "Context Adherence Detector";
  public readonly description = "Detects use of external knowledge instead of provided context";
  
  private confidenceThreshold: number;
  private worldKnowledgeIndicators: string[];
  private contextRequirementStrict: boolean;
  
  constructor(config: {
    confidenceThreshold?: number;
    contextRequirementStrict?: boolean;
  } = {}) {
    this.confidenceThreshold = config.confidenceThreshold ?? 0.7;
    this.contextRequirementStrict = config.contextRequirementStrict ?? true;
    this.worldKnowledgeIndicators = this.initializeWorldKnowledgeIndicators();
  }
  
  async detect(
    actualBehavior: unknown,
    expectedBehavior: ExpectedBehavior,
    scenario: TestScenario,
    context?: unknown
  ): Promise<HallucinationInstance[]> {
    const hallucinations: HallucinationInstance[] = [];
    
    // Extract context sources from scenario and execution context
    const contextSources = this.extractContextSources(scenario, context);
    
    // Analyze actual behavior for context usage
    const contextReferences = this.extractContextReferences(actualBehavior, contextSources);
    
    // Detect world knowledge leakage
    const worldKnowledgeViolations = await this.detectWorldKnowledgeUsage(
      actualBehavior, 
      contextSources,
      contextReferences
    );
    hallucinations.push(...worldKnowledgeViolations);
    
    // Detect context misinterpretation
    const misinterpretationViolations = await this.detectContextMisinterpretation(
      actualBehavior,
      contextSources,
      contextReferences
    );
    hallucinations.push(...misinterpretationViolations);
    
    // Detect missing required context usage
    const missingContextViolations = await this.detectMissingContextUsage(
      contextReferences,
      contextSources,
      expectedBehavior
    );
    hallucinations.push(...missingContextViolations);
    
    // Detect canary trap context violations
    const canaryViolations = await this.detectCanaryContextViolations(
      actualBehavior,
      scenario.canaryTraps || []
    );
    hallucinations.push(...canaryViolations);
    
    return hallucinations;
  }
  
  calculateConfidence(evidence: unknown): number {
    const evidenceObj = evidence as any;
    
    // High confidence for direct world knowledge indicators
    if (evidenceObj?.worldKnowledgeIndicators?.length > 0) {
      return Math.min(0.95, 0.7 + (evidenceObj.worldKnowledgeIndicators.length * 0.1));
    }
    
    // Very high confidence for canary trap violations
    if (evidenceObj?.canaryTrapViolation) {
      return 0.98;
    }
    
    // Moderate confidence for context misinterpretation
    if (evidenceObj?.misinterpretation) {
      return 0.75;
    }
    
    return 0.6;
  }
  
  async validate(): Promise<boolean> {
    if (this.confidenceThreshold < 0 || this.confidenceThreshold > 1) {
      console.error('Invalid confidence threshold for ContextAdherenceDetector');
      return false;
    }
    
    if (this.worldKnowledgeIndicators.length === 0) {
      console.warn('No world knowledge indicators configured');
    }
    
    return true;
  }
  
  private initializeWorldKnowledgeIndicators(): string[] {
    return [
      // Explicit world knowledge claims
      "as we all know",
      "it is well known",
      "common knowledge",
      "generally understood",
      "widely accepted",
      "everyone knows",
      "obviously",
      "clearly",
      "of course",
      
      // Temporal references outside context
      "historically",
      "in the past",
      "traditionally",
      "over the years",
      
      // External authority references
      "experts say",
      "research shows",
      "studies indicate", 
      "according to science",
      "best practices dictate",
      
      // Assumption markers
      "presumably",
      "it stands to reason",
      "logically",
      "naturally",
      "intuitively"
    ];
  }
  
  private extractContextSources(scenario: TestScenario, context: unknown): ContextSource[] {
    const sources: ContextSource[] = [];
    
    // Add scenario context
    if (scenario.context && Object.keys(scenario.context).length > 0) {
      sources.push({
        name: "scenario_context",
        content: scenario.context,
        priority: 1,
        required: true
      });
    }
    
    // Add execution context
    if (context) {
      sources.push({
        name: "execution_context", 
        content: context,
        priority: 2,
        required: false
      });
    }
    
    // Add input as context source
    sources.push({
      name: "input_data",
      content: scenario.input,
      priority: 1,
      required: true
    });
    
    return sources;
  }
  
  private extractContextReferences(
    actualBehavior: unknown, 
    contextSources: ContextSource[]
  ): ContextReference[] {
    const references: ContextReference[] = [];
    const behaviorStr = JSON.stringify(actualBehavior);
    
    for (const source of contextSources) {
      const sourceContentStr = JSON.stringify(source.content);
      
      // Find direct quotes (exact text matches)
      const directMatches = this.findDirectMatches(behaviorStr, sourceContentStr);
      for (const match of directMatches) {
        references.push({
          source: source.name,
          content: match,
          confidence: 0.95,
          isDirectQuote: true,
          isParaphrase: false,
          isImplied: false
        });
      }
      
      // Find paraphrases (similar concepts, different wording)
      const paraphrases = this.findParaphrases(behaviorStr, sourceContentStr);
      for (const paraphrase of paraphrases) {
        references.push({
          source: source.name,
          content: paraphrase,
          confidence: 0.75,
          isDirectQuote: false,
          isParaphrase: true,
          isImplied: false
        });
      }
    }
    
    return references;
  }
  
  private async detectWorldKnowledgeUsage(
    actualBehavior: unknown,
    contextSources: ContextSource[],
    contextReferences: ContextReference[]
  ): Promise<HallucinationInstance[]> {
    const violations: HallucinationInstance[] = [];
    const behaviorStr = JSON.stringify(actualBehavior).toLowerCase();
    
    // Check for explicit world knowledge indicators
    const foundIndicators: string[] = [];
    for (const indicator of this.worldKnowledgeIndicators) {
      if (behaviorStr.includes(indicator.toLowerCase())) {
        foundIndicators.push(indicator);
      }
    }
    
    if (foundIndicators.length > 0) {
      violations.push({
        detectorType: this.type,
        confidence: this.calculateConfidence({ worldKnowledgeIndicators: foundIndicators }),
        description: `World knowledge usage detected via indicators: ${foundIndicators.join(', ')}`,
        evidence: {
          indicators: foundIndicators,
          contextAvailable: contextSources.length > 0,
          contextReferencesCount: contextReferences.length
        },
        severity: foundIndicators.length > 2 ? 'critical' : 'high',
        suggestedFix: 'Base decision solely on provided context without external knowledge assumptions'
      });
    }
    
    // Check for specific facts not present in context
    const externalFacts = await this.detectExternalFactUsage(behaviorStr, contextSources);
    for (const fact of externalFacts) {
      violations.push({
        detectorType: this.type,
        confidence: 0.8,
        description: `External fact usage: ${fact.description}`,
        evidence: {
          fact: fact.content,
          expectedSource: "provided context",
          actualSource: "external knowledge"
        },
        severity: 'high',
        suggestedFix: `Verify if "${fact.content}" is present in provided context before using`
      });
    }
    
    return violations;
  }
  
  private async detectContextMisinterpretation(
    actualBehavior: unknown,
    contextSources: ContextSource[],
    contextReferences: ContextReference[]
  ): Promise<HallucinationInstance[]> {
    const violations: HallucinationInstance[] = [];
    
    // Check if context references are used correctly
    for (const reference of contextReferences) {
      const sourceContent = contextSources.find(s => s.name === reference.source)?.content;
      if (!sourceContent) continue;
      
      const isAccurate = await this.validateContextAccuracy(reference, sourceContent);
      
      if (!isAccurate.accurate) {
        violations.push({
          detectorType: this.type,
          confidence: 0.85,
          description: `Context misinterpretation: ${isAccurate.description}`,
          evidence: {
            reference: reference.content,
            originalContext: sourceContent,
            misinterpretationType: isAccurate.type
          },
          severity: 'medium',
          suggestedFix: `Reread original context and ensure accurate interpretation: ${isAccurate.correction}`
        });
      }
    }
    
    return violations;
  }
  
  private async detectMissingContextUsage(
    contextReferences: ContextReference[],
    contextSources: ContextSource[],
    expectedBehavior: ExpectedBehavior
  ): Promise<HallucinationInstance[]> {
    const violations: HallucinationInstance[] = [];
    
    if (!this.contextRequirementStrict) return violations;
    
    // Check if required context sources were referenced
    const requiredSources = contextSources.filter(s => s.required);
    const referencedSources = new Set(contextReferences.map(r => r.source));
    
    for (const requiredSource of requiredSources) {
      if (!referencedSources.has(requiredSource.name)) {
        violations.push({
          detectorType: this.type,
          confidence: 0.9,
          description: `Missing required context usage: ${requiredSource.name}`,
          evidence: {
            requiredSource: requiredSource.name,
            availableContext: requiredSource.content,
            referencedSources: Array.from(referencedSources)
          },
          severity: 'high',
          suggestedFix: `Incorporate information from ${requiredSource.name} into decision-making process`
        });
      }
    }
    
    return violations;
  }
  
  private async detectCanaryContextViolations(
    actualBehavior: unknown,
    canaryTraps: any[]
  ): Promise<HallucinationInstance[]> {
    const violations: HallucinationInstance[] = [];
    const behaviorStr = JSON.stringify(actualBehavior).toLowerCase();
    
    for (const trap of canaryTraps) {
      // Check if canary trap content is referenced as if it were real context
      const trapContentStr = JSON.stringify(trap.content).toLowerCase();
      
      if (behaviorStr.includes(trapContentStr) || 
          trap.detectablePatterns?.some((pattern: string) => behaviorStr.includes(pattern.toLowerCase()))) {
        
        violations.push({
          detectorType: this.type,
          confidence: 0.98,
          description: `Canary trap treated as valid context: ${trap.description}`,
          evidence: {
            canaryTrapViolation: true,
            trapId: trap.id,
            trapType: trap.type,
            expectedBehavior: trap.expectedBehavior
          },
          severity: 'critical',
          suggestedFix: `Ignore fictional context from canary trap: ${trap.id}`
        });
      }
    }
    
    return violations;
  }
  
  private findDirectMatches(behavior: string, sourceContent: string): string[] {
    const matches: string[] = [];
    
    // Find sequences of 5+ words that match exactly
    const words = sourceContent.split(/\s+/);
    for (let i = 0; i <= words.length - 5; i++) {
      const phrase = words.slice(i, i + 5).join(' ');
      if (behavior.includes(phrase) && phrase.length > 20) {
        matches.push(phrase);
      }
    }
    
    return matches;
  }
  
  private findParaphrases(behavior: string, sourceContent: string): string[] {
    // Simplified paraphrase detection - in production would use semantic similarity
    const paraphrases: string[] = [];
    
    // Look for key concepts that appear in both
    const sourceWords = sourceContent.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const behaviorLower = behavior.toLowerCase();
    
    let commonConceptCount = 0;
    const commonConcepts: string[] = [];
    
    for (const word of sourceWords) {
      if (behaviorLower.includes(word)) {
        commonConceptCount++;
        commonConcepts.push(word);
      }
    }
    
    // If many concepts overlap, likely paraphrase
    if (commonConceptCount >= 3 && commonConcepts.length > 0) {
      paraphrases.push(`Paraphrased content involving: ${commonConcepts.slice(0, 3).join(', ')}`);
    }
    
    return paraphrases;
  }
  
  private async detectExternalFactUsage(
    behaviorStr: string, 
    contextSources: ContextSource[]
  ): Promise<Array<{ content: string; description: string }>> {
    const externalFacts: Array<{ content: string; description: string }> = [];
    
    // Combine all context content for checking
    const allContextContent = contextSources
      .map(s => JSON.stringify(s.content))
      .join(' ')
      .toLowerCase();
    
    // Look for specific fact patterns that might be external knowledge
    const factPatterns = [
      /(?:it is (?:a )?fact that|the fact is) (.+?)(?:\.|$)/gi,
      /(?:research shows|studies indicate) (.+?)(?:\.|$)/gi,
      /(?:according to|based on) (.+?)(?:\.|$)/gi
    ];
    
    for (const pattern of factPatterns) {
      const matches = behaviorStr.matchAll(pattern);
      for (const match of matches) {
        const fact = match[1]?.trim();
        if (fact && fact.length > 10 && !allContextContent.includes(fact.toLowerCase())) {
          externalFacts.push({
            content: fact,
            description: `Fact not found in provided context: ${fact.substring(0, 50)}...`
          });
        }
      }
    }
    
    return externalFacts;
  }
  
  private async validateContextAccuracy(
    reference: ContextReference, 
    originalContext: unknown
  ): Promise<{
    accurate: boolean;
    description: string;
    type: string;
    correction?: string;
  }> {
    // Simplified accuracy validation - in production would use semantic comparison
    const originalStr = JSON.stringify(originalContext).toLowerCase();
    const referenceStr = reference.content.toLowerCase();
    
    // Check for obvious inversions or negations
    if (originalStr.includes('not') && !referenceStr.includes('not')) {
      return {
        accurate: false,
        description: 'Negation removed from original context',
        type: 'negation_error',
        correction: 'Include original negation in interpretation'
      };
    }
    
    if (!originalStr.includes('not') && referenceStr.includes('not')) {
      return {
        accurate: false,
        description: 'Negation added to original context',
        type: 'negation_error',
        correction: 'Remove added negation to match original'
      };
    }
    
    // For now, assume most references are accurate unless obvious errors
    return {
      accurate: true,
      description: 'Context reference appears accurate',
      type: 'accurate'
    };
  }
}

/**
 * Factory for creating Atlas-specific context detectors
 */
export class ContextDetectorFactory {
  static createAtlasContextDetector(): ContextAdherenceDetector {
    return new ContextAdherenceDetector({
      confidenceThreshold: 0.8, // Higher threshold for production
      contextRequirementStrict: true // Require context usage for Atlas decisions
    });
  }
  
  static createLenientContextDetector(): ContextAdherenceDetector {
    return new ContextAdherenceDetector({
      confidenceThreshold: 0.6,
      contextRequirementStrict: false // Allow some external knowledge
    });
  }
}