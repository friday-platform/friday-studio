import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "../../../../src/core/memory/coala-memory.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class MemoryAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  
  constructor(id?: string) {
    super(id);

    // Set agent-specific prompts
    this.prompts = {
      system: `You are the Memory Agent for the Telephone Game workspace. Your role is to manage memory operations at the beginning and end of each session.

**At Session Start (LOAD mode):**
- Analyze relevant past telephone game sessions
- Extract patterns from previous message transformations
- Identify successful transformation strategies
- Provide context about common mishearing patterns, embellishment themes, and reinterpretation styles
- Format output as structured context for other agents

**At Session End (STORE mode):**
- Analyze the session results and transformation chain
- Extract key patterns and learnings
- Categorize insights by memory type:
  - PROCEDURAL: Successful transformation techniques
  - EPISODIC: Specific interesting transformation examples  
  - SEMANTIC: General knowledge about language patterns
  - CONTEXTUAL: Session-specific metadata
- Store insights in appropriate memory types

**Analysis Focus:**
- Transformation quality and creativity
- Pattern recognition in mishearing/embellishment/reinterpretation
- Success metrics (message clarity, entertainment value, coherence)
- Common failure modes to avoid
- Effective agent collaboration patterns`,
      user: "",
    };
  }

  name(): string {
    return "MemoryAgent";
  }

  nickname(): string {
    return "Memory";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "local";
  }

  purpose(): string {
    return "Manages memory operations at session start and end, loading context and storing learnings";
  }

  controls(): object {
    return {
      canLoadMemory: true,
      canStoreMemory: true,
      canAnalyzePatterns: true,
      memoryTypes: ["procedural", "episodic", "semantic", "contextual"],
    };
  }

  // Expose CoALA memory methods for external access
  getMemoryTypeStatistics() {
    const coalaMemory = this.memory as CoALAMemoryManager;
    return coalaMemory.getMemoryTypeStatistics();
  }

  getMemoriesByType(memoryType: CoALAMemoryType) {
    const coalaMemory = this.memory as CoALAMemoryManager;
    return coalaMemory.getMemoriesByType(memoryType);
  }

  async getStorageStatistics() {
    const coalaMemory = this.memory as CoALAMemoryManager;
    return await coalaMemory.getStorageStatistics();
  }

  // Clean up memory resources
  dispose() {
    const coalaMemory = this.memory as CoALAMemoryManager;
    coalaMemory.dispose();
  }

  override getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  async loadSessionContext(sessionIntent?: string): Promise<string> {
    this.log("Loading relevant memory context for new session");
    
    const coalaMemory = this.memory as CoALAMemoryManager;
    
    // Get relevant memories from different types
    const proceduralMemories = coalaMemory.getMemoriesByType(CoALAMemoryType.PROCEDURAL);
    const episodicMemories = coalaMemory.getMemoriesByType(CoALAMemoryType.EPISODIC);
    const semanticMemories = coalaMemory.getMemoriesByType(CoALAMemoryType.SEMANTIC);
    
    // Query for telephone game specific memories
    const telephoneMemories = coalaMemory.queryMemories({
      tags: ["telephone-game", "transformation", "pattern"],
      minRelevance: 0.4,
      limit: 10
    });

    // Build context prompt for LLM analysis
    const contextPrompt = `LOAD MODE: Analyze past telephone game memories and provide session context.

PROCEDURAL MEMORIES (${proceduralMemories.length} entries):
${proceduralMemories.slice(0, 3).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

EPISODIC MEMORIES (${episodicMemories.length} entries):
${episodicMemories.slice(0, 3).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

SEMANTIC MEMORIES (${semanticMemories.length} entries):
${semanticMemories.slice(0, 3).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

TELEPHONE-SPECIFIC MEMORIES (${telephoneMemories.length} entries):
${telephoneMemories.slice(0, 5).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

SESSION INTENT: ${sessionIntent || 'Standard telephone game transformation'}

Provide structured context that will help the mishearing, embellishment, and reinterpretation agents perform better based on past learnings. Focus on:
1. Successful transformation patterns
2. Common pitfalls to avoid  
3. Effective collaboration strategies
4. Quality improvement suggestions`;

    try {
      // Use LLM to analyze and synthesize context
      const contextAnalysis = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        contextPrompt,
        false // Don't include memory context to avoid recursion
      );

      // Remember this context loading operation
      this.rememberInteraction('context-load', {
        sessionIntent,
        memoriesAnalyzed: {
          procedural: proceduralMemories.length,
          episodic: episodicMemories.length,
          semantic: semanticMemories.length,
          telephoneSpecific: telephoneMemories.length
        },
        contextGenerated: contextAnalysis.length
      });

      return contextAnalysis;

    } catch (error) {
      this.log(`Error loading session context: ${error}`);
      
      // Provide fallback context
      return `TELEPHONE GAME CONTEXT (Fallback):
- Focus on creative but believable transformations
- Maintain message flow through all three agents
- Each agent should add their unique transformation style
- Preserve core narrative elements while introducing changes
- Past sessions show best results with sequential processing`;
    }
  }

  async storeSessionLearnings(sessionResults: any): Promise<string> {
    this.log("Storing session learnings in memory");
    
    const coalaMemory = this.memory as CoALAMemoryManager;
    
    // Build analysis prompt
    const analysisPrompt = `STORE MODE: Analyze telephone game session results and extract learnings.

SESSION RESULTS:
${JSON.stringify(sessionResults, null, 2)}

Analyze this session and extract insights for future sessions. Categorize learnings by memory type:

1. PROCEDURAL: What transformation techniques worked well?
2. EPISODIC: What were the most interesting/successful transformations?
3. SEMANTIC: What language patterns or knowledge was demonstrated?
4. CONTEXTUAL: What session-specific metadata should be remembered?

Provide specific, actionable insights that will improve future telephone game sessions.`;

    try {
      // Use LLM to analyze session results
      const analysis = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        analysisPrompt,
        false // Don't include memory context to avoid recursion
      );

      // Parse analysis and store in appropriate memory types
      await this.extractAndStoreInsights(analysis, sessionResults);

      // Remember this storage operation
      this.rememberInteraction('session-storage', {
        sessionId: sessionResults.sessionId,
        analysisLength: analysis.length,
        insightsExtracted: true
      });

      return analysis;

    } catch (error) {
      this.log(`Error storing session learnings: ${error}`);
      
      // Still try to store basic session info
      coalaMemory.rememberWithMetadata(
        `session-basic-${Date.now()}`,
        {
          sessionResults,
          timestamp: new Date(),
          analysisStatus: 'failed'
        },
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: ['telephone-game', 'session', 'basic-storage'],
          relevanceScore: 0.3
        }
      );

      return `Session data stored with basic information due to analysis error: ${error}`;
    }
  }

  private async extractAndStoreInsights(analysis: string, sessionResults: any): Promise<void> {
    const coalaMemory = this.memory as CoALAMemoryManager;
    const timestamp = Date.now();

    // Simple pattern extraction (could be enhanced with more sophisticated parsing)
    const lines = analysis.split('\n').filter(line => line.trim());
    
    let currentSection = '';
    let proceduralInsights: string[] = [];
    let episodicInsights: string[] = [];
    let semanticInsights: string[] = [];
    let contextualInsights: string[] = [];

    for (const line of lines) {
      const cleanLine = line.trim();
      
      if (cleanLine.includes('PROCEDURAL')) {
        currentSection = 'procedural';
      } else if (cleanLine.includes('EPISODIC')) {
        currentSection = 'episodic';
      } else if (cleanLine.includes('SEMANTIC')) {
        currentSection = 'semantic';
      } else if (cleanLine.includes('CONTEXTUAL')) {
        currentSection = 'contextual';
      } else if (cleanLine.startsWith('-') || cleanLine.match(/^\d+\./)) {
        // This is an insight point
        const insight = cleanLine.replace(/^[-\d.]\s*/, '');
        
        switch (currentSection) {
          case 'procedural':
            proceduralInsights.push(insight);
            break;
          case 'episodic':
            episodicInsights.push(insight);
            break;
          case 'semantic':
            semanticInsights.push(insight);
            break;
          case 'contextual':
            contextualInsights.push(insight);
            break;
        }
      }
    }

    // Store procedural insights
    if (proceduralInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `procedural-insights-${timestamp}`,
        {
          type: 'transformation-techniques',
          insights: proceduralInsights,
          sourceSession: sessionResults.sessionId,
          extractedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.PROCEDURAL,
          tags: ['telephone-game', 'transformation', 'technique', 'pattern'],
          relevanceScore: 0.8,
          confidence: 0.9
        }
      );
    }

    // Store episodic insights
    if (episodicInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `episodic-insights-${timestamp}`,
        {
          type: 'session-highlights',
          insights: episodicInsights,
          sessionResults: sessionResults,
          extractedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: ['telephone-game', 'session', 'highlight', 'example'],
          relevanceScore: 0.7,
          confidence: 0.9
        }
      );
    }

    // Store semantic insights
    if (semanticInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `semantic-insights-${timestamp}`,
        {
          type: 'language-patterns',
          insights: semanticInsights,
          domain: 'telephone-game',
          extractedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.SEMANTIC,
          tags: ['telephone-game', 'language', 'pattern', 'knowledge'],
          relevanceScore: 0.9,
          confidence: 0.8
        }
      );
    }

    // Store contextual insights
    if (contextualInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `contextual-insights-${timestamp}`,
        {
          type: 'session-context',
          insights: contextualInsights,
          sessionMetadata: {
            sessionId: sessionResults.sessionId,
            timestamp: new Date()
          }
        },
        {
          memoryType: CoALAMemoryType.CONTEXTUAL,
          tags: ['telephone-game', 'session', 'context', 'metadata'],
          relevanceScore: 0.5,
          confidence: 0.8
        }
      );
    }

    this.log(`Stored insights: ${proceduralInsights.length} procedural, ${episodicInsights.length} episodic, ${semanticInsights.length} semantic, ${contextualInsights.length} contextual`);
  }

  async *invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Memory Agent processing: ${message.slice(0, 50)}...`);

    // Add to message history
    this.messages.newMessage(message, "human" as any);

    let response: string;

    // Determine if this is a LOAD or STORE operation
    if (message.toLowerCase().includes('load') || message.toLowerCase().includes('start') || message.toLowerCase().includes('begin')) {
      response = await this.loadSessionContext(message);
    } else if (message.toLowerCase().includes('store') || message.toLowerCase().includes('end') || message.toLowerCase().includes('complete')) {
      // Try to parse session results from message
      let sessionResults;
      try {
        // Look for JSON in the message
        const jsonMatch = message.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          sessionResults = JSON.parse(jsonMatch[0]);
        } else {
          sessionResults = { sessionData: message, sessionId: `session-${Date.now()}` };
        }
      } catch {
        sessionResults = { sessionData: message, sessionId: `session-${Date.now()}` };
      }
      
      response = await this.storeSessionLearnings(sessionResults);
    } else {
      // General memory query
      response = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        message
      );
    }

    // Simply yield the entire response
    yield response;

    // Add response to message history
    this.messages.newMessage(response, "agent" as any);
  }

  async invoke(message: string): Promise<string> {
    this.status = "processing";

    try {
      let fullResponse = "";
      for await (const chunk of this.invokeStream(message)) {
        fullResponse += chunk;
      }

      this.status = "idle";
      return fullResponse;
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }
}