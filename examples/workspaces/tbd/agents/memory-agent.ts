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
      system: `You are the Memory Agent for the TBD (To Be Determined) workspace. Your role is to manage memory operations at the beginning and end of each session.

**At Session Start (LOAD mode):**
- Analyze relevant past sessions and user interactions
- Extract patterns from previous questions, tasks, and responses
- Identify successful response strategies and user preferences
- Provide context about common topics, user behavior patterns, and effective approaches
- Format output as structured context for the TBD agent

**At Session End (STORE mode):**
- Analyze the session results and user interaction
- Extract key insights and learnings
- Categorize insights by memory type:
  - PROCEDURAL: Successful response techniques and problem-solving approaches
  - EPISODIC: Specific user interactions and notable conversations
  - SEMANTIC: General knowledge topics and factual information discussed
  - CONTEXTUAL: Session-specific metadata and user preferences
- Store insights in appropriate memory types

**Analysis Focus:**
- User satisfaction and response quality
- Topic categories and knowledge domains
- Effective communication patterns
- Common user needs and question types
- Response accuracy and helpfulness
- User engagement and follow-up patterns`,
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
    return "Manages memory operations for TBD workspace, loading context and storing learnings from user interactions";
  }

  controls(): object {
    return {
      canLoadMemory: true,
      canStoreMemory: true,
      canAnalyzePatterns: true,
      canTrackUserPreferences: true,
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

  async loadSessionContext(userMessage?: string): Promise<string> {
    this.log("Loading relevant memory context for new TBD session");
    
    const coalaMemory = this.memory as CoALAMemoryManager;
    
    // Get relevant memories from different types
    const proceduralMemories = coalaMemory.getMemoriesByType(CoALAMemoryType.PROCEDURAL);
    const episodicMemories = coalaMemory.getMemoriesByType(CoALAMemoryType.EPISODIC);
    const semanticMemories = coalaMemory.getMemoriesByType(CoALAMemoryType.SEMANTIC);
    
    // Query for user interaction specific memories
    const userInteractionMemories = coalaMemory.queryMemories({
      tags: ["user-interaction", "question", "task", "helpful"],
      minRelevance: 0.4,
      limit: 10
    });

    // Build context prompt for LLM analysis
    const contextPrompt = `LOAD MODE: Analyze past TBD workspace interactions and provide session context.

USER MESSAGE: ${userMessage || 'General assistance request'}

PROCEDURAL MEMORIES (${proceduralMemories.length} entries):
${proceduralMemories.slice(0, 3).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

EPISODIC MEMORIES (${episodicMemories.length} entries):
${episodicMemories.slice(0, 3).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

SEMANTIC MEMORIES (${semanticMemories.length} entries):
${semanticMemories.slice(0, 3).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

USER INTERACTION MEMORIES (${userInteractionMemories.length} entries):
${userInteractionMemories.slice(0, 5).map(m => `- ${JSON.stringify(m.content)}`).join('\n')}

Provide structured context that will help the TBD agent respond better based on past learnings. Focus on:
1. User communication patterns and preferences
2. Successful response strategies for similar requests
3. Common topics and knowledge domains
4. Effective problem-solving approaches
5. User satisfaction patterns`;

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
        userMessage,
        memoriesAnalyzed: {
          procedural: proceduralMemories.length,
          episodic: episodicMemories.length,
          semantic: semanticMemories.length,
          userInteraction: userInteractionMemories.length
        },
        contextGenerated: contextAnalysis.length
      });

      return contextAnalysis;

    } catch (error) {
      this.log(`Error loading session context: ${error}`);
      
      // Provide fallback context
      return `TBD WORKSPACE CONTEXT (Fallback):
- Be helpful, accurate, and clear in responses
- Ask clarifying questions when user intent is unclear
- Provide structured information when appropriate
- Be friendly and professional in tone
- Past sessions show users appreciate detailed explanations`;
    }
  }

  async storeSessionLearnings(sessionResults: any): Promise<string> {
    this.log("Storing TBD session learnings in memory");
    
    const coalaMemory = this.memory as CoALAMemoryManager;
    
    // Build analysis prompt
    const analysisPrompt = `STORE MODE: Analyze TBD workspace session results and extract learnings.

SESSION RESULTS:
${JSON.stringify(sessionResults, null, 2)}

Analyze this session and extract insights for future user interactions. Categorize learnings by memory type:

1. PROCEDURAL: What response techniques and approaches worked well?
2. EPISODIC: What were the key user interactions and notable conversations?
3. SEMANTIC: What knowledge topics or factual information was discussed?
4. CONTEXTUAL: What session-specific metadata and user preferences were observed?

Focus on improving future responses and user satisfaction.`;

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
          tags: ['tbd-workspace', 'session', 'basic-storage'],
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

    // Store procedural insights (response techniques)
    if (proceduralInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `procedural-insights-${timestamp}`,
        {
          type: 'response-techniques',
          insights: proceduralInsights,
          sourceSession: sessionResults.sessionId,
          extractedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.PROCEDURAL,
          tags: ['tbd-workspace', 'response-technique', 'helpful', 'approach'],
          relevanceScore: 0.8,
          confidence: 0.9
        }
      );
    }

    // Store episodic insights (user interactions)
    if (episodicInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `episodic-insights-${timestamp}`,
        {
          type: 'user-interactions',
          insights: episodicInsights,
          sessionResults: sessionResults,
          extractedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: ['tbd-workspace', 'user-interaction', 'conversation', 'session'],
          relevanceScore: 0.7,
          confidence: 0.9
        }
      );
    }

    // Store semantic insights (knowledge topics)
    if (semanticInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `semantic-insights-${timestamp}`,
        {
          type: 'knowledge-topics',
          insights: semanticInsights,
          domain: 'tbd-workspace',
          extractedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.SEMANTIC,
          tags: ['tbd-workspace', 'knowledge', 'topic', 'information'],
          relevanceScore: 0.9,
          confidence: 0.8
        }
      );
    }

    // Store contextual insights (user preferences, session metadata)
    if (contextualInsights.length > 0) {
      coalaMemory.rememberWithMetadata(
        `contextual-insights-${timestamp}`,
        {
          type: 'user-preferences',
          insights: contextualInsights,
          sessionMetadata: {
            sessionId: sessionResults.sessionId,
            timestamp: new Date()
          }
        },
        {
          memoryType: CoALAMemoryType.CONTEXTUAL,
          tags: ['tbd-workspace', 'user-preference', 'context', 'metadata'],
          relevanceScore: 0.6,
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
      // Extract user message from load request
      const userMessageMatch = message.match(/user message:?\s*["']?([^"'\n]+)["']?/i);
      const userMessage = userMessageMatch ? userMessageMatch[1] : message;
      response = await this.loadSessionContext(userMessage);
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
      // General memory query or analysis
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