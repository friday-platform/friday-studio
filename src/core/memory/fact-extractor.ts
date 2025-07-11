/**
 * LLM-based Fact Extraction from Signals
 * Analyzes signal content to extract structured facts for semantic memory
 */

import {
  ExtractedFact,
  KnowledgeEntityType,
  KnowledgeGraphManager,
  KnowledgeRelationType,
} from "./knowledge-graph.ts";
import { BaseAgent } from "../agents/base-agent-v2.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";
import type { IWorkspaceSignal } from "../../types/core.ts";

export interface SignalFactExtractionResult {
  extractedFacts: ExtractedFact[];
  storedFactIds: string[];
  analysisMetadata: {
    signalId: string;
    signalProvider: string;
    processingTime: number;
    factsFound: number;
    confidence: number;
  };
}

export class FactExtractor extends BaseAgent {
  private knowledgeGraph: KnowledgeGraphManager;
  private workspaceId: string;

  constructor(
    memoryConfig: AtlasMemoryConfig,
    knowledgeGraph: KnowledgeGraphManager,
    workspaceId: string,
    parentScopeId?: string,
  ) {
    super(memoryConfig, parentScopeId);
    this.knowledgeGraph = knowledgeGraph;
    this.workspaceId = workspaceId;

    // Set prompts property
    this.prompts = {
      system:
        "You are a knowledge extraction specialist focused on extracting structured facts for workspace knowledge management.",
      user:
        "Analyze content and extract facts that will be valuable for future reference and automation.",
    };
  }

  // Implement required BaseAgent methods
  name(): string {
    return "FactExtractor";
  }

  nickname(): string {
    return "fact-extractor";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas-semantic-memory";
  }

  purpose(): string {
    return "Extract structured facts from signals for workspace semantic memory";
  }

  controls(): object {
    return {
      extractionEnabled: true,
      maxFactsPerSignal: 50,
      minimumConfidence: 0.5,
      supportedEntityTypes: Object.values(KnowledgeEntityType),
      supportedRelationTypes: Object.values(KnowledgeRelationType),
    };
  }

  // Extract facts from complete session execution (runs once at session end)
  async extractFactsFromSessionExecution(
    sessionId: string,
    signal: IWorkspaceSignal,
    _payload: any,
    workingMemoryEntries: any[],
    _sessionSummary: string,
    sessionContent: string,
  ): Promise<SignalFactExtractionResult> {
    const startTime = Date.now();

    try {
      this.log(`Starting comprehensive fact extraction from session: ${sessionId}`);

      // Extract facts using LLM with session-wide context
      const extractedFacts = await this.performSessionFactExtraction(
        sessionContent,
        sessionId,
        signal,
        workingMemoryEntries.length,
      );

      // Store facts in knowledge graph
      const storedFactIds = await this.knowledgeGraph.storeFacts(extractedFacts);

      const processingTime = Date.now() - startTime;
      const averageConfidence = extractedFacts.length > 0
        ? extractedFacts.reduce((sum, fact) => sum + fact.confidence, 0) / extractedFacts.length
        : 0;

      this.log(
        `Extracted ${extractedFacts.length} facts from session ${sessionId} in ${processingTime}ms`,
      );

      return {
        extractedFacts,
        storedFactIds,
        analysisMetadata: {
          signalId: sessionId,
          signalProvider: "session-execution",
          processingTime,
          factsFound: extractedFacts.length,
          confidence: averageConfidence,
        },
      };
    } catch (error) {
      this.log(`Error extracting facts from session ${sessionId}: ${error}`);
      throw new Error(`Session fact extraction failed: ${error}`);
    }
  }

  // Extract facts from agent execution results (legacy method - kept for compatibility)
  async extractFactsFromAgentExecution(
    agentId: string,
    task: any,
    input: any,
    output: any,
    context: Record<string, any>,
  ): Promise<SignalFactExtractionResult> {
    const startTime = Date.now();

    try {
      this.log(`Starting fact extraction from agent execution: ${agentId}`);

      // Prepare agent execution content for analysis
      const executionContent = this.prepareAgentExecutionContent(
        agentId,
        task,
        input,
        output,
        context,
      );

      // Extract facts using LLM
      const extractedFacts = await this.performAgentFactExtraction(executionContent, agentId);

      // Store facts in knowledge graph
      const storedFactIds = await this.knowledgeGraph.storeFacts(extractedFacts);

      const processingTime = Date.now() - startTime;
      const averageConfidence = extractedFacts.length > 0
        ? extractedFacts.reduce((sum, fact) => sum + fact.confidence, 0) / extractedFacts.length
        : 0;

      this.log(
        `Extracted ${extractedFacts.length} facts from agent ${agentId} execution in ${processingTime}ms`,
      );

      return {
        extractedFacts,
        storedFactIds,
        analysisMetadata: {
          signalId: agentId,
          signalProvider: "agent-execution",
          processingTime,
          factsFound: extractedFacts.length,
          confidence: averageConfidence,
        },
      };
    } catch (error) {
      this.log(`Error extracting facts from agent ${agentId} execution: ${error}`);
      throw new Error(`Agent fact extraction failed: ${error}`);
    }
  }

  // Main method to extract facts from a signal
  async extractFactsFromSignal(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<SignalFactExtractionResult> {
    const startTime = Date.now();

    try {
      this.log(`Starting fact extraction from signal: ${signal.id}`);

      // Prepare signal content for analysis
      const signalContent = this.prepareSignalContent(signal, payload);

      // Extract facts using LLM
      const extractedFacts = await this.performFactExtraction(signalContent, signal.id);

      // Store facts in knowledge graph
      const storedFactIds = await this.knowledgeGraph.storeFacts(extractedFacts);

      const processingTime = Date.now() - startTime;
      const averageConfidence = extractedFacts.length > 0
        ? extractedFacts.reduce((sum, fact) => sum + fact.confidence, 0) / extractedFacts.length
        : 0;

      this.log(
        `Extracted ${extractedFacts.length} facts from signal ${signal.id} in ${processingTime}ms`,
      );

      return {
        extractedFacts,
        storedFactIds,
        analysisMetadata: {
          signalId: signal.id,
          signalProvider: signal.provider?.name || "unknown",
          processingTime,
          factsFound: extractedFacts.length,
          confidence: averageConfidence,
        },
      };
    } catch (error) {
      this.log(`Error extracting facts from signal ${signal.id}: ${error}`);
      throw new Error(`Fact extraction failed: ${error}`);
    }
  }

  // Prepare signal content for LLM analysis
  private prepareSignalContent(signal: IWorkspaceSignal, payload: any): string {
    const signalContext = {
      signalId: signal.id,
      provider: signal.provider?.name || "unknown",
      payload: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      timestamp: new Date().toISOString(),
    };

    return `Signal Analysis Context:
Signal ID: ${signalContext.signalId}
Provider: ${signalContext.provider}
Timestamp: ${signalContext.timestamp}

Signal Content:
${signalContext.payload}`;
  }

  // Prepare agent execution content for LLM analysis
  private prepareAgentExecutionContent(
    agentId: string,
    task: any,
    input: any,
    output: any,
    context: Record<string, any>,
  ): string {
    const executionContext = {
      agentId,
      task: typeof task === "string"
        ? task
        : (task?.task || task?.description || JSON.stringify(task)),
      input: typeof input === "string" ? input : JSON.stringify(input, null, 2),
      output: typeof output === "string" ? output : JSON.stringify(output, null, 2),
      context: JSON.stringify(context, null, 2),
      timestamp: new Date().toISOString(),
    };

    return `Agent Execution Analysis Context:
Agent ID: ${executionContext.agentId}
Task: ${executionContext.task}
Timestamp: ${executionContext.timestamp}

Agent Input:
${executionContext.input}

Agent Output:
${executionContext.output}

Execution Context:
${executionContext.context}`;
  }

  // Perform LLM-based fact extraction
  private async performFactExtraction(
    signalContent: string,
    signalId: string,
  ): Promise<ExtractedFact[]> {
    const extractionPrompt =
      `Analyze the following signal content and extract structured facts that are relevant to workspace knowledge management.

${signalContent}

Extract facts in the following categories with high confidence:

**PERSON INFORMATION:**
- User roles: "The user is a software engineer", "John is a data scientist"
- Personal attributes: "Preferred name is Alex", "Primary language is Spanish"
- Skills and expertise: "Expert in Python", "Knows React development"

**PREFERENCES:**
- Personal preferences: "Favorite color is blue", "Prefers dark mode"
- Tool preferences: "Uses VS Code", "Prefers PostgreSQL over MySQL"
- Workflow preferences: "Likes detailed documentation", "Prefers async communication"

**IDENTIFIERS & NUMBERS:**
- Important numbers: "Remember the number 123", "Port 8080", "Version 2.1.4"
- IDs and codes: "User ID is user_123", "API key starts with sk_"
- Constants: "Default timeout is 30 seconds"

**TEAM & PROJECT INFO:**
- Team names: "Atlas team", "Frontend squad", "DevOps team"
- Project names: "Project Phoenix", "Migration to cloud", "API redesign"
- Organization info: "Company name is TechCorp", "Department is Engineering"

**SERVICE & TECHNOLOGY INFO:**
- GitHub repositories: "repo: atlas/main", "github.com/company/project"
- AWS resources: "instance i-1234567", "S3 bucket: prod-data-bucket"
- URLs and endpoints: "API at https://api.example.com", "Database at db.example.com"
- Technology stack: "Uses Next.js", "Deployed on AWS", "Database is PostgreSQL"

**GENERAL FACTS:**
- Business rules: "Maximum file size is 10MB", "Sessions expire after 1 hour"
- Relationships: "Service A depends on Service B", "User reports to Manager X"
- Status information: "Project is in testing phase", "Feature is deprecated"

For each fact, provide:
1. **Type**: One of [person_info, preference, identifier, service_info, team_info, project_info, general_fact]
2. **Statement**: Natural language statement of the fact
3. **Entities**: Objects/people/concepts involved with their types and attributes
4. **Relationships**: How entities relate to each other
5. **Confidence**: 0.0-1.0 confidence in the fact accuracy
6. **Context**: Source context for the fact

Return ONLY a valid JSON array of facts with this structure:
[
  {
    "type": "person_info",
    "statement": "The user is a software engineer",
    "entities": [
      {
        "type": "person",
        "name": "user",
        "attributes": {"role": "software engineer", "domain": "engineering"}
      }
    ],
    "relationships": [
      {
        "type": "is_a",
        "source": "user",
        "target": "software engineer",
        "attributes": {"domain": "professional_role"}
      }
    ],
    "confidence": 0.9,
    "context": "Extracted from signal content"
  }
]

IMPORTANT: 
- Only extract facts that are clearly stated or strongly implied
- Use confidence scores appropriately (0.9+ for explicit facts, 0.7+ for strong implications, 0.5+ for weak implications)
- Avoid extracting temporary or contextual information unless specifically important
- Focus on facts that would be valuable for future workspace sessions
- Return empty array [] if no significant facts are found`;

    try {
      const llmResponse = await this.generateLLM(
        "claude-4-sonnet-20250514",
        "You are a knowledge extraction specialist. Your task is to analyze text content and extract structured facts for a workspace knowledge management system. Focus on extracting facts that will be valuable for future reference and automation.",
        extractionPrompt,
        false, // Don't include memory context to avoid recursion
        {
          operation: "extract_facts_from_signal",
          signalId: signalId,
          workspaceId: this.workspaceId,
        },
      );

      // Parse LLM response as JSON
      const cleanedResponse = this.cleanLLMResponse(llmResponse);
      const extractedFacts: ExtractedFact[] = JSON.parse(cleanedResponse);

      // Validate and enhance extracted facts
      return this.validateAndEnhanceFacts(extractedFacts, signalId);
    } catch (error) {
      this.log(`Error in LLM fact extraction: ${error}`);
      this.log(`LLM Response that failed parsing: ${error}`);
      return []; // Return empty array on parsing failure
    }
  }

  // Perform LLM-based fact extraction from agent execution
  private async performAgentFactExtraction(
    executionContent: string,
    agentId: string,
  ): Promise<ExtractedFact[]> {
    const extractionPrompt =
      `Analyze the following agent execution and extract structured facts that reveal new workspace knowledge.

${executionContent}

Extract facts from AGENT OUTPUTS, INTERACTIONS, and DISCOVERIES with focus on:

**DISCOVERED INFORMATION:**
- New user details: "User works at Company X", "User's timezone is UTC-8"
- Generated content: "Created file config.json", "Generated API key abc123"
- Analysis results: "Code uses React version 18", "Database has 1000 records"

**PROCESS INSIGHTS:**
- Tool capabilities: "Agent can access GitHub API", "Service supports webhook notifications"
- Workflow patterns: "User prefers async communication", "Deployment happens daily at 3PM"
- Error patterns: "Service fails when memory > 80%", "API rate limited at 100 requests/hour"

**REVEALED PREFERENCES:**
- User behaviors: "Prefers detailed error messages", "Uses snake_case naming"
- System configurations: "Default timeout is 30s", "Max file size is 10MB"
- Technical choices: "Uses PostgreSQL database", "Deployed on AWS region us-east-1"

**RELATIONSHIP DISCOVERIES:**
- Dependencies: "Service A depends on Service B", "User manages Team Alpha"
- Connections: "Repository linked to deployment pipeline", "User has admin access to production"
- Associations: "Project uses CI/CD tool Jenkins", "Team follows agile methodology"

**EXTRACTED ARTIFACTS:**
- Generated IDs: "Created user ID usr_12345", "Generated session token sess_abc"
- File paths: "Configuration at /etc/app/config.yaml", "Logs stored in /var/log/app/"
- URLs and endpoints: "API endpoint https://api.service.com/v1", "Dashboard at https://dash.service.com"

**IMPORTANT**: Only extract facts that reveal NEW information about:
- User attributes, preferences, or behaviors
- System configurations, capabilities, or limitations  
- Generated resources, files, or identifiers
- Discovered relationships or dependencies
- Technical specifications or constraints

Do NOT extract temporary execution details, generic responses, or obvious technical facts.

Return ONLY a valid JSON array of facts with this structure:
[
  {
    "type": "person_info|preference|identifier|service_info|team_info|project_info|general_fact",
    "statement": "Clear factual statement of the discovery",
    "entities": [
      {
        "type": "person|project|service|concept|preference|identifier|team|technology|location|fact",
        "name": "entity_name",
        "attributes": {"key": "value", "discovered_by": "${agentId}"}
      }
    ],
    "relationships": [
      {
        "type": "is_a|part_of|works_on|uses|prefers|owns|member_of|located_at|related_to|has_attribute|knows",
        "source": "source_entity_name",
        "target": "target_entity_name", 
        "attributes": {"discovered_by": "${agentId}", "context": "execution_context"}
      }
    ],
    "confidence": 0.0-1.0,
    "context": "Extracted from agent ${agentId} execution"
  }
]

Return empty array [] if no significant new facts are discovered.`;

    try {
      const llmResponse = await this.generateLLM(
        "claude-4-sonnet-20250514",
        "You are a knowledge extraction specialist analyzing agent execution outputs. Focus on extracting NEW, valuable facts discovered during agent execution that reveal workspace knowledge, user preferences, system configurations, or important relationships.",
        extractionPrompt,
        false, // Don't include memory context to avoid recursion
        {
          operation: "extract_facts_from_agent_execution",
          agentId: agentId,
          workspaceId: this.workspaceId,
        },
      );

      // Parse LLM response as JSON
      const cleanedResponse = this.cleanLLMResponse(llmResponse);
      const extractedFacts: ExtractedFact[] = JSON.parse(cleanedResponse);

      // Validate and enhance extracted facts
      return this.validateAndEnhanceFacts(extractedFacts, agentId);
    } catch (error) {
      this.log(`Error in LLM agent fact extraction: ${error}`);
      this.log(`LLM Response that failed parsing: ${error}`);
      return []; // Return empty array on parsing failure
    }
  }

  // Perform LLM-based fact extraction from complete session
  private async performSessionFactExtraction(
    sessionContent: string,
    sessionId: string,
    signal: IWorkspaceSignal,
    executionCount: number,
  ): Promise<ExtractedFact[]> {
    const extractionPrompt =
      `Analyze the following complete session execution and extract structured facts that represent valuable workspace knowledge discovered during the entire session.

${sessionContent}

**COMPREHENSIVE SESSION FACT EXTRACTION**

Focus on extracting facts that represent the complete picture of what was discovered, learned, or produced during this session. Consider the entire agent execution chain and their collective outputs:

**SESSION-LEVEL DISCOVERIES:**
- New workspace capabilities: "Workspace can process large datasets", "System supports automated deployments"
- User behavior patterns: "User prefers iterative refinement", "User works in Pacific timezone"
- Process insights: "Multi-agent collaboration improves accuracy", "Sequential processing works best for this workflow"

**KNOWLEDGE CONSOLIDATION:**
- Confirmed relationships: "Service X integrates with Service Y", "Team Alpha owns Project Beta"
- Technical discoveries: "API supports webhooks", "Database schema includes user preferences table"
- Workflow patterns: "Standard deployment involves 3 agents", "Error handling requires human approval"

**ACCUMULATED PREFERENCES:**
- User preferences revealed through choices: "Prefers detailed explanations", "Values efficiency over completeness"
- System configurations discovered: "Default timeout is 30 seconds", "Maximum file size is 100MB"
- Tool and technology usage: "Primary development environment is VS Code", "Deployment target is AWS"

**BUSINESS INSIGHTS:**
- Project status and progress: "Migration project is 75% complete", "Testing phase identified 3 critical issues"
- Team dynamics: "Frontend team collaborates with Backend team", "DevOps team handles all deployments"
- Resource constraints: "Limited to 5 concurrent executions", "Budget constraint requires cost optimization"

**IMPORTANT CHARACTERISTICS:**
- Only extract facts that provide VALUE across future sessions
- Focus on PERSISTENT knowledge rather than session-specific details
- Prioritize facts that reveal USER PREFERENCES, SYSTEM CAPABILITIES, and WORKFLOW PATTERNS
- Ignore temporary execution details like specific timestamps or ephemeral IDs
- Extract RELATIONSHIPS between entities that were discovered or confirmed

**CONFIDENCE GUIDELINES:**
- 0.9+ for explicitly stated facts confirmed by multiple agents
- 0.8+ for facts strongly implied by consistent patterns across agents
- 0.7+ for reasonable inferences from agent outputs and behaviors
- 0.6+ for tentative discoveries that may need further confirmation

Return ONLY a valid JSON array of facts with this structure:
[
  {
    "type": "person_info|preference|identifier|service_info|team_info|project_info|general_fact",
    "statement": "Clear, valuable statement of discovered knowledge",
    "entities": [
      {
        "type": "person|project|service|concept|preference|identifier|team|technology|location|fact",
        "name": "entity_name",
        "attributes": {"key": "value", "discovered_in_session": "${sessionId}", "execution_count": ${executionCount}}
      }
    ],
    "relationships": [
      {
        "type": "is_a|part_of|works_on|uses|prefers|owns|member_of|located_at|related_to|has_attribute|knows",
        "source": "source_entity_name",
        "target": "target_entity_name", 
        "attributes": {"discovered_in_session": "${sessionId}", "signal_type": "${signal.id}", "confidence_basis": "multi_agent_confirmation|pattern_analysis|explicit_statement"}
      }
    ],
    "confidence": 0.0-1.0,
    "context": "Extracted from session ${sessionId} with ${executionCount} agent executions"
  }
]

**CRITICAL**: Return empty array [] if no significant, valuable facts were discovered that would benefit future sessions.`;

    try {
      const llmResponse = await this.generateLLM(
        "claude-4-sonnet-20250514",
        "You are a knowledge extraction specialist analyzing complete session executions. Focus on extracting VALUABLE, PERSISTENT facts that represent knowledge accumulated across all agent executions in the session. Prioritize discoveries that will benefit future workspace sessions.",
        extractionPrompt,
        false, // Don't include memory context to avoid recursion
        {
          operation: "extract_facts_from_session_execution",
          sessionId: sessionId,
          signalId: signal.id,
          executionCount: executionCount,
          workspaceId: this.workspaceId,
        },
      );

      // Parse LLM response as JSON
      const cleanedResponse = this.cleanLLMResponse(llmResponse);
      const extractedFacts: ExtractedFact[] = JSON.parse(cleanedResponse);

      // Validate and enhance extracted facts
      return this.validateAndEnhanceFacts(extractedFacts, sessionId);
    } catch (error) {
      this.log(`Error in LLM session fact extraction: ${error}`);
      this.log(`LLM Response that failed parsing: ${error}`);
      return []; // Return empty array on parsing failure
    }
  }

  // Clean LLM response to ensure valid JSON
  private cleanLLMResponse(response: string): string {
    // Remove markdown code blocks if present
    let cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "");

    // Find the array start and end
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");

    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
    }

    return cleaned.trim();
  }

  // Validate and enhance extracted facts
  private validateAndEnhanceFacts(facts: ExtractedFact[], signalId: string): ExtractedFact[] {
    return facts
      .filter((fact) => this.isValidFact(fact))
      .map((fact) => this.enhanceFact(fact, signalId));
  }

  // Validate individual fact structure
  private isValidFact(fact: any): fact is ExtractedFact {
    return (
      fact &&
      typeof fact.type === "string" &&
      typeof fact.statement === "string" &&
      Array.isArray(fact.entities) &&
      Array.isArray(fact.relationships) &&
      typeof fact.confidence === "number" &&
      fact.confidence >= 0 && fact.confidence <= 1 &&
      typeof fact.context === "string"
    );
  }

  // Enhance fact with additional metadata
  private enhanceFact(fact: ExtractedFact, signalId: string): ExtractedFact {
    return {
      ...fact,
      context: `Signal: ${signalId} | ${fact.context}`,
      // Normalize entity types
      entities: fact.entities.map((entity) => ({
        ...entity,
        type: this.normalizeEntityType(entity.type),
        attributes: {
          ...entity.attributes,
          extractedFrom: signalId,
          extractedAt: new Date().toISOString(),
        },
      })),
      // Normalize relationship types
      relationships: fact.relationships.map((rel) => ({
        ...rel,
        type: this.normalizeRelationType(rel.type),
        attributes: {
          ...rel.attributes,
          extractedFrom: signalId,
          extractedAt: new Date().toISOString(),
        },
      })),
    };
  }

  // Normalize entity type to match enum
  private normalizeEntityType(type: any): KnowledgeEntityType {
    const typeStr = String(type).toLowerCase();
    switch (typeStr) {
      case "person":
      case "user":
      case "people":
        return KnowledgeEntityType.PERSON;
      case "project":
        return KnowledgeEntityType.PROJECT;
      case "service":
      case "application":
      case "app":
        return KnowledgeEntityType.SERVICE;
      case "concept":
      case "idea":
        return KnowledgeEntityType.CONCEPT;
      case "preference":
      case "setting":
        return KnowledgeEntityType.PREFERENCE;
      case "identifier":
      case "id":
      case "number":
        return KnowledgeEntityType.IDENTIFIER;
      case "team":
      case "group":
      case "squad":
        return KnowledgeEntityType.TEAM;
      case "technology":
      case "tech":
      case "tool":
        return KnowledgeEntityType.TECHNOLOGY;
      case "location":
      case "place":
        return KnowledgeEntityType.LOCATION;
      default:
        return KnowledgeEntityType.FACT;
    }
  }

  // Normalize relationship type to match enum
  private normalizeRelationType(type: any): KnowledgeRelationType {
    const typeStr = String(type).toLowerCase();
    switch (typeStr) {
      case "is_a":
      case "is":
      case "isa":
        return KnowledgeRelationType.IS_A;
      case "part_of":
      case "belongs_to":
        return KnowledgeRelationType.PART_OF;
      case "works_on":
      case "working_on":
        return KnowledgeRelationType.WORKS_ON;
      case "uses":
      case "utilizes":
        return KnowledgeRelationType.USES;
      case "prefers":
      case "likes":
        return KnowledgeRelationType.PREFERS;
      case "owns":
      case "has":
        return KnowledgeRelationType.OWNS;
      case "member_of":
      case "in":
        return KnowledgeRelationType.MEMBER_OF;
      case "located_at":
      case "at":
        return KnowledgeRelationType.LOCATED_AT;
      case "knows":
      case "familiar_with":
        return KnowledgeRelationType.KNOWS;
      case "has_attribute":
      case "attribute":
        return KnowledgeRelationType.HAS_ATTRIBUTE;
      default:
        return KnowledgeRelationType.RELATED_TO;
    }
  }

  // Get existing facts for deduplication check
  async getExistingFacts(statement: string): Promise<boolean> {
    try {
      const existingFacts = await this.knowledgeGraph.queryKnowledge({
        search: statement,
        minConfidence: 0.5,
      });

      return existingFacts.facts.some((fact) =>
        fact.statement.toLowerCase().includes(statement.toLowerCase()) ||
        statement.toLowerCase().includes(fact.statement.toLowerCase())
      );
    } catch (error) {
      this.log(`Error checking existing facts: ${error}`);
      return false;
    }
  }

  // Get workspace knowledge summary for context
  async getWorkspaceKnowledgeContext(): Promise<string> {
    try {
      const summary = await this.knowledgeGraph.getWorkspaceKnowledgeSummary();
      return `Workspace Knowledge Summary:
- Entities: ${summary.totalEntities}
- Relationships: ${summary.totalRelationships}  
- Facts: ${summary.totalFacts}
- Top Entity Types: ${
        Object.entries(summary.entityTypes)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([type, count]) => `${type}(${count})`)
          .join(", ")
      }`;
    } catch (error) {
      this.log(`Error getting workspace context: ${error}`);
      return "No existing workspace knowledge available.";
    }
  }
}
