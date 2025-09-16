/**
 * Memory Classification System for MECMF
 *
 * Implements intelligent content classification based on MECMF Section 2.5.1 and Section 4.1.
 * Automatically categorizes content into appropriate memory types using rule-based analysis
 * enhanced with pattern recognition.
 */

import {
  type ClassificationRules,
  type ConversationContext,
  type Entity,
  type MemoryClassifier,
  type MemoryEntry,
  MemoryType,
} from "./mecmf-interfaces.ts";

interface ClassificationResult {
  memoryType: MemoryType;
  confidence: number;
  reasoning: string;
  suggestedTags: string[];
  entities: Entity[];
}

interface TemporalMarkers {
  hasTimeReferences: boolean;
  hasSequenceIndicators: boolean;
  hasOutcomeMarkers: boolean;
  referencedTimeframe: "immediate" | "recent" | "historical" | "future" | "unknown";
}

interface ContentAnalysis {
  isFactual: boolean;
  isProcedural: boolean;
  isExperiential: boolean;
  isContextual: boolean;
  hasKnowledgeStructures: boolean;
  confidenceLevel: number;
  temporalMarkers: TemporalMarkers;
  keyPhrases: string[];
}

export class AtlasMemoryClassifier implements MemoryClassifier {
  // Keeping for potential future heuristics tuning
  private readonly classificationRules: ClassificationRules;

  // Pattern definitions for memory type identification
  private readonly patterns = {
    working: {
      sessionKeywords: ["current", "now", "today", "this session", "right now", "currently"],
      contextKeywords: ["context", "state", "status", "active", "ongoing", "immediate"],
      temporalKeywords: ["temporary", "short-term", "for now", "at the moment"],
    },
    episodic: {
      experienceKeywords: [
        "happened",
        "occurred",
        "experienced",
        "learned",
        "tried",
        "result",
        "outcome",
      ],
      temporalKeywords: [
        "yesterday",
        "last time",
        "previously",
        "when",
        "during",
        "after",
        "before",
      ],
      outcomeKeywords: [
        "succeeded",
        "failed",
        "worked",
        "didn't work",
        "error",
        "success",
        "issue",
        "problem",
      ],
      learningKeywords: ["learned", "discovered", "found out", "realized", "mistake", "lesson"],
    },
    semantic: {
      factualKeywords: [
        "is",
        "are",
        "definition",
        "means",
        "represents",
        "concept",
        "fact",
        "knowledge",
      ],
      knowledgeKeywords: [
        "theory",
        "principle",
        "rule",
        "law",
        "property",
        "characteristic",
        "feature",
      ],
      generalKeywords: ["always", "never", "typically", "generally", "usually", "commonly"],
    },
    procedural: {
      instructionKeywords: [
        "how to",
        "step",
        "process",
        "procedure",
        "method",
        "approach",
        "technique",
      ],
      sequenceKeywords: ["first", "then", "next", "finally", "after", "before", "following"],
      actionKeywords: ["do", "perform", "execute", "run", "implement", "configure", "setup"],
      ruleKeywords: ["should", "must", "always", "never", "requirement", "guideline", "policy"],
    },
  };

  constructor() {
    this.classificationRules = {
      working_memory: {
        contains_session_context: true,
        temporal_relevance: "immediate",
        lifespan: "session_scoped",
      },
      episodic_memory: {
        contains_outcomes: true,
        temporal_markers: true,
        experience_indicators: ["success", "failure", "learning"],
      },
      semantic_memory: {
        factual_content: true,
        knowledge_structures: true,
        cross_session_relevance: true,
      },
    };

    // Keep references to avoid linter unused errors while preserving for future tuning
    void this.classificationRules;
    void this.patterns;
  }

  classifyContent(content: string, context: ConversationContext): MemoryType {
    const analysis = this.analyzeContent(content, context);
    const result = this.determineMemoryType(analysis, context);
    return result.memoryType;
  }

  classifyContentDetailed(content: string, context: ConversationContext): ClassificationResult {
    const analysis = this.analyzeContent(content, context);
    return this.determineMemoryType(analysis, context);
  }

  extractKeyEntities(content: string): Entity[] {
    const entities: Entity[] = [];
    const text = content || "";

    // Emails
    const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const emails = Array.from(new Set(text.match(emailRegex) || []));
    emails.forEach((email) => {
      entities.push({ name: email, type: "email", confidence: 0.95 });
    });

    // URLs
    const urlRegex = /https?:\/\/[\w.-]+(?:\/[\w\-./?%&=]*)?/g;
    const urls = Array.from(new Set(text.match(urlRegex) || []));
    urls.forEach((u) => {
      entities.push({ name: u, type: "url", confidence: 0.9 });
    });

    // Phone numbers (simple E.164 and common formats)
    // Updated to handle more formats including +1-555-0123, (555) 123-4567, etc.
    const phoneRegex =
      /(\+\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3,4}([- ]?\d{3,4})?|\+\d{1,3}-\d{3}-\d{4}/g;
    const phones = Array.from(new Set(text.match(phoneRegex) || []));
    phones.forEach((p) => {
      entities.push({ name: p, type: "phone", confidence: 0.7 });
    });

    // Dates (ISO and common formats)
    const dateRegexes = [
      /\b\d{4}-\d{2}-\d{2}\b/g, // YYYY-MM-DD
      /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // MM/DD/YYYY or M/D/YY
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/gi,
    ];
    for (const rx of dateRegexes) {
      const matches = Array.from(new Set(text.match(rx) || []));
      matches.forEach((d) => {
        entities.push({ name: d, type: "date", confidence: 0.75 });
      });
    }

    // Usernames (e.g., @handle)
    const usernameRegex = /@([A-Za-z0-9_-]{2,})/g;
    const usernames = Array.from(
      new Set(Array.from(text.matchAll(usernameRegex)).map((m) => m[1] || "")),
    ).filter(Boolean);
    usernames.forEach((u) => {
      entities.push({ name: u, type: "username", confidence: 0.7 });
    });

    // Repo identifiers (org/repo)
    const repoRegex = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g;
    const repos = Array.from(
      new Set(Array.from(text.matchAll(repoRegex)).map((m) => `${m[1] || ""}/${m[2] || ""}`)),
    ).filter((v) => v !== "/");
    repos.forEach((r) => {
      entities.push({ name: r, type: "repo", confidence: 0.7 });
    });

    // UUIDs
    const uuidRegex =
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
    const uuids = Array.from(new Set(text.match(uuidRegex) || []));
    uuids.forEach((id) => {
      entities.push({ name: id, type: "id", confidence: 0.95 });
    });

    // Fallback simple patterns for names (heuristic)
    const nameRegex = /\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;
    const names = Array.from(
      new Set(Array.from(text.matchAll(nameRegex)).map((m) => (m[1] || "").toString())),
    ).filter(Boolean);
    names.forEach((n) => {
      entities.push({ name: n, type: "name", confidence: 0.6 });
    });

    return entities;
  }

  calculateRelevanceScore(memory: MemoryEntry, query: string): number {
    const contentText = this.extractTextContent(memory.content ?? "");

    // Multi-factor relevance calculation
    const semanticScore = this.calculateSemanticRelevance(contentText, query);
    const temporalScore = this.calculateTemporalRelevance(memory);
    const typeScore = this.calculateTypeRelevance(memory.memoryType, query);

    // Weighted combination
    const relevanceScore = semanticScore * 0.4 + temporalScore * 0.2 + typeScore * 0.2;

    return Math.min(1.0, Math.max(0.0, relevanceScore));
  }

  /**
   * Comprehensive content analysis
   */
  private analyzeContent(content: string, _context: ConversationContext): ContentAnalysis {
    const lowercaseContent = content.toLowerCase();

    // Analyze temporal markers
    const temporalMarkers = this.analyzeTemporalMarkers(content);

    // Check for different content types
    const isFactual = this.isFactualContent(lowercaseContent);
    const isProcedural = this.isProceduralContent(lowercaseContent);
    const isExperiential = this.isExperientialContent(lowercaseContent, temporalMarkers);
    const isContextual = this.isContextualContent(lowercaseContent, {
      sessionId: "",
      workspaceId: "",
      recentMessages: [],
      activeAgents: [],
    });

    // Analyze knowledge structures
    const hasKnowledgeStructures = this.hasKnowledgeStructures(content);

    // Extract key phrases
    const keyPhrases = this.extractKeyPhrases(content);

    // Calculate overall confidence
    const confidenceLevel = this.calculateAnalysisConfidence(
      content,
      isFactual,
      isProcedural,
      isExperiential,
      isContextual,
      temporalMarkers,
    );

    return {
      isFactual,
      isProcedural,
      isExperiential,
      isContextual,
      hasKnowledgeStructures,
      confidenceLevel,
      temporalMarkers,
      keyPhrases,
    };
  }

  /**
   * Determine memory type based on content analysis
   */
  private determineMemoryType(
    analysis: ContentAnalysis,
    _context: ConversationContext,
  ): ClassificationResult {
    const scores = {
      [MemoryType.WORKING]: 0,
      [MemoryType.EPISODIC]: 0,
      [MemoryType.SEMANTIC]: 0,
      [MemoryType.PROCEDURAL]: 0,
      [MemoryType.SESSION_BRIDGE]: 0,
    };

    const reasoning: string[] = [];
    const suggestedTags: string[] = [];

    // Working memory scoring
    if (analysis.isContextual) {
      scores[MemoryType.WORKING] += 0.4;
      reasoning.push("Contains session context");
    }
    if (analysis.temporalMarkers.referencedTimeframe === "immediate") {
      scores[MemoryType.WORKING] += 0.3;
      reasoning.push("References immediate timeframe");
    }

    // Episodic memory scoring
    if (analysis.isExperiential) {
      scores[MemoryType.EPISODIC] += 0.4;
      reasoning.push("Contains experiential content");
      suggestedTags.push("experience");
    }
    if (analysis.temporalMarkers.hasOutcomeMarkers) {
      scores[MemoryType.EPISODIC] += 0.3;
      reasoning.push("Contains outcome markers");
      suggestedTags.push("outcome");
    }
    if (analysis.temporalMarkers.hasTimeReferences) {
      scores[MemoryType.EPISODIC] += 0.2;
      reasoning.push("Has temporal references");
    }

    // Semantic memory scoring
    if (analysis.isFactual) {
      scores[MemoryType.SEMANTIC] += 0.4;
      reasoning.push("Contains factual content");
      suggestedTags.push("fact");
    }
    if (analysis.hasKnowledgeStructures) {
      scores[MemoryType.SEMANTIC] += 0.3;
      reasoning.push("Has knowledge structures");
      suggestedTags.push("knowledge");
    }

    // Procedural memory scoring
    if (analysis.isProcedural) {
      scores[MemoryType.PROCEDURAL] += 0.5;
      reasoning.push("Contains procedural content");
      suggestedTags.push("procedure");
    }

    // Find the highest scoring type
    const sortedTypes = Object.values(MemoryType)
      .map((type) => [type, scores[type]] as const)
      .sort(([, a], [, b]) => b - a);
    const [topType, topScore] = sortedTypes[0] || [MemoryType.WORKING, 0.5];
    const confidence = Math.min(1.0, (topScore || 0.5) * analysis.confidenceLevel);

    return {
      memoryType: topType,
      confidence,
      reasoning: reasoning.join("; "),
      suggestedTags: [...new Set(suggestedTags)], // Remove duplicates
      entities: [], // Would be populated by extractKeyEntities separately
    };
  }

  /**
   * Type guard for valid timeframe values
   */
  private isValidTimeframe(value: string): value is TemporalMarkers["referencedTimeframe"] {
    return ["immediate", "recent", "historical", "future", "unknown"].includes(value);
  }

  /**
   * Analyze temporal markers in content
   */
  private analyzeTemporalMarkers(content: string): TemporalMarkers {
    const lowercaseContent = content.toLowerCase();

    // Time reference patterns
    const timePatterns = {
      immediate: ["now", "currently", "right now", "at the moment", "today"],
      recent: ["recently", "just", "yesterday", "last", "earlier", "before"],
      historical: ["previously", "in the past", "ago", "former", "old"],
      future: ["will", "going to", "next", "future", "plan", "upcoming"],
      unknown: ["unknown", "unspecified", "not specified", "not provided", "not available"],
    };

    // Sequence indicators
    const sequencePatterns = ["first", "then", "next", "after", "before", "finally", "step"];

    // Outcome markers
    const outcomePatterns = [
      "result",
      "outcome",
      "success",
      "failure",
      "error",
      "worked",
      "failed",
    ];

    let referencedTimeframe: TemporalMarkers["referencedTimeframe"] = "unknown";
    let maxMatches = 0;

    // Determine primary timeframe
    for (const [timeframe, patterns] of Object.entries(timePatterns)) {
      const matches = patterns.filter((pattern) => lowercaseContent.includes(pattern)).length;
      if (matches > maxMatches && this.isValidTimeframe(timeframe)) {
        maxMatches = matches;
        referencedTimeframe = timeframe;
      }
    }

    return {
      hasTimeReferences: maxMatches > 0,
      hasSequenceIndicators: sequencePatterns.some((pattern) => lowercaseContent.includes(pattern)),
      hasOutcomeMarkers: outcomePatterns.some((pattern) => lowercaseContent.includes(pattern)),
      referencedTimeframe,
    };
  }

  /**
   * Check if content is factual
   */
  private isFactualContent(content: string): boolean {
    const factualIndicators = [
      "is",
      "are",
      "was",
      "were",
      "definition",
      "means",
      "represents",
      "fact",
      "property",
      "characteristic",
      "always",
      "never",
      "typically",
    ];

    const knowledgeIndicators = [
      "programming language",
      "language",
      "technology",
      "framework",
      "library",
      "tool",
      "system",
      "typed",
      "builds on",
      "based on",
      "supports",
      "provides",
      "allows",
      "enables",
    ];

    const factualMatches = factualIndicators.filter((indicator) =>
      content.toLowerCase().includes(indicator),
    ).length;
    const knowledgeMatches = knowledgeIndicators.filter((indicator) =>
      content.toLowerCase().includes(indicator),
    ).length;

    // Consider factual if it has factual indicators OR knowledge indicators that suggest technical/semantic content
    return factualMatches >= 1 || knowledgeMatches >= 2;
  }

  /**
   * Check if content is procedural
   */
  private isProceduralContent(content: string): boolean {
    const proceduralIndicators = [
      "how to",
      "step",
      "process",
      "procedure",
      "method",
      "first",
      "then",
      "next",
      "should",
      "must",
      "do",
      "perform",
      "execute",
      "configure",
    ];

    return proceduralIndicators.filter((indicator) => content.includes(indicator)).length >= 2;
  }

  /**
   * Check if content is experiential
   */
  private isExperientialContent(content: string, temporalMarkers: TemporalMarkers): boolean {
    const experientialIndicators = [
      "happened",
      "occurred",
      "experienced",
      "tried",
      "learned",
      "discovered",
      "mistake",
      "lesson",
      "succeeded",
      "failed",
      "worked",
      "didn't work",
    ];

    const hasExperientialWords =
      experientialIndicators.filter((indicator) => content.includes(indicator)).length >= 1;

    return hasExperientialWords || temporalMarkers.hasOutcomeMarkers;
  }

  /**
   * Check if content is contextual (session-related)
   */
  private isContextualContent(content: string, context: ConversationContext): boolean {
    // Check for session-specific references
    const sessionIndicators = [
      "current",
      "this session",
      "right now",
      "currently",
      "active",
      "ongoing",
      "immediate",
      "state",
      "status",
    ];

    // Check for references to current context
    const hasSessionWords = sessionIndicators.some((indicator) => content.includes(indicator));

    // Check for references to current task or workspace
    const hasContextReferences = context.currentTask
      ? content.toLowerCase().includes(context.currentTask.toLowerCase())
      : false;

    return hasSessionWords || hasContextReferences;
  }

  /**
   * Check for knowledge structures
   */
  private hasKnowledgeStructures(content: string): boolean {
    const structureIndicators = [
      "theory",
      "principle",
      "concept",
      "model",
      "framework",
      "system",
      "relationship",
      "depends on",
      "related to",
      "consists of",
      "comprised of",
    ];

    return (
      structureIndicators.filter((indicator) => content.toLowerCase().includes(indicator)).length >=
      1
    );
  }

  /**
   * Extract key phrases from content
   */
  private extractKeyPhrases(content: string): string[] {
    // Simple phrase extraction - in production, could use NLP libraries
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const phrases: string[] = [];

    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      if (words.length >= 2 && words.length <= 4) {
        phrases.push(words.join(" ").toLowerCase());
      }
    }

    return phrases.slice(0, 5); // Return top 5 phrases
  }

  /**
   * Calculate analysis confidence
   */
  private calculateAnalysisConfidence(
    content: string,
    isFactual: boolean,
    isProcedural: boolean,
    isExperiential: boolean,
    isContextual: boolean,
    temporalMarkers: TemporalMarkers,
  ): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence based on clear indicators
    if (isFactual || isProcedural || isExperiential || isContextual) confidence += 0.2;
    if (temporalMarkers.hasTimeReferences) confidence += 0.1;
    if (temporalMarkers.hasOutcomeMarkers) confidence += 0.1;

    // Content length factor
    const wordCount = content.split(/\s+/).length;
    if (wordCount >= 10) confidence += 0.1;

    return Math.min(1.0, confidence);
  }

  /**
   * Calculate semantic relevance between content and query
   */
  private calculateSemanticRelevance(content: string, query: string): number {
    const contentWords = new Set(content.toLowerCase().split(/\s+/));
    const queryWords = new Set(query.toLowerCase().split(/\s+/));

    const intersection = new Set([...contentWords].filter((x) => queryWords.has(x)));
    const union = new Set([...contentWords, ...queryWords]);

    return intersection.size / union.size; // Jaccard similarity
  }

  /**
   * Calculate temporal relevance based on memory age
   */
  private calculateTemporalRelevance(memory: MemoryEntry): number {
    const ageMs = Date.now() - memory.timestamp.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    // Exponential decay with half-life of 24 hours
    return Math.exp(-ageHours / 24);
  }

  /**
   * Calculate type-specific relevance
   */
  private calculateTypeRelevance(memoryType: MemoryType, query: string): number {
    const queryLower = query.toLowerCase();

    // Boost scores for certain query patterns
    if (queryLower.includes("how") && memoryType === MemoryType.PROCEDURAL) return 1.0;
    if (queryLower.includes("what") && memoryType === MemoryType.SEMANTIC) return 0.8;
    if (queryLower.includes("when") && memoryType === MemoryType.EPISODIC) return 0.8;
    if (queryLower.includes("current") && memoryType === MemoryType.WORKING) return 1.0;

    return 0.5; // Neutral relevance
  }

  /**
   * Extract text content from various content types
   */
  private extractTextContent(content: string | Record<string, string>): string {
    if (typeof content === "string") {
      return content;
    } else if (typeof content === "object" && content !== null) {
      const textFields = ["text", "content", "description", "statement", "summary"];

      for (const field of textFields) {
        const contentObj = content;
        if (contentObj[field] && typeof contentObj[field] === "string") {
          return contentObj[field];
        }
      }

      return JSON.stringify(content);
    }

    return String(content);
  }
}

// Factory function
export function createMemoryClassifier(): AtlasMemoryClassifier {
  return new AtlasMemoryClassifier();
}
