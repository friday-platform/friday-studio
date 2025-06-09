import type { 
  IWorkspaceAgent,
  IWorkspaceSignal,
  IAtlasScope
} from "../types/core.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

// Session-specific context provided by WorkspaceSupervisor
export interface SessionContext {
  sessionId: string;
  workspaceId: string;
  signal: IWorkspaceSignal;
  payload: any;
  availableAgents: AgentMetadata[];
  filteredMemory: any[];
  constraints?: {
    timeLimit?: number;
    costLimit?: number;
  };
  // Additional prompts to layer onto the session
  additionalPrompts?: {
    signal?: string;      // Signal-specific prompt
    session?: string;     // Session-specific prompt
    evaluation?: string;  // Evaluation-specific prompt
  };
}

export interface AgentMetadata {
  id: string;
  name: string;
  type: string;
  purpose: string;
  capabilities?: string[];
}

export interface ExecutionPlan {
  id: string;
  sessionId: string;
  phases: ExecutionPhase[];
  successCriteria: string[];
  adaptationStrategy: 'rigid' | 'flexible' | 'exploratory';
}

export interface ExecutionPhase {
  id: string;
  name: string;
  agents: AgentTask[];
  executionStrategy: 'sequential' | 'parallel';
  continueCondition?: string;
}

export interface AgentTask {
  agentId: string;
  task: string;
  inputSource: 'signal' | 'previous' | 'combined';
  dependencies?: string[];
}

export interface AgentResult {
  agentId: string;
  task: string;
  input: any;
  output: any;
  duration: number;
  timestamp: string;
}

export class SessionSupervisor extends BaseAgent {
  protected sessionContext: SessionContext | null = null;
  private executionPlan: ExecutionPlan | null = null;
  private executionResults: AgentResult[] = [];

  constructor(parentScopeId?: string) {
    super(parentScopeId);
    
    // Set supervisor-specific prompts
    this.prompts = {
      system: `You are a Session Supervisor responsible for coordinating agent execution within a workspace session.
Your role is to:
1. Analyze incoming signals and their payloads
2. Create intelligent execution plans based on available agents
3. Coordinate agent execution and data flow
4. Evaluate results and adapt the plan if needed
5. Determine when the session goal has been achieved

You have access to a filtered view of the workspace tailored for this specific session.`,
      user: ""
    };
  }

  name(): string {
    return "SessionSupervisor";
  }

  nickname(): string {
    return "Session Supervisor";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas";
  }

  purpose(): string {
    return "Intelligently coordinates agent execution within a session based on signals and goals";
  }

  controls(): object {
    return {
      canPlan: true,
      canCoordinate: true,
      canEvaluate: true,
      canAdapt: true
    };
  }

  override getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  getSessionContext(): SessionContext | null {
    return this.sessionContext;
  }

  // Initialize session with context from WorkspaceSupervisor
  async initializeSession(context: SessionContext): Promise<void> {
    this.sessionContext = context;
    this.log(`Initializing session ${context.sessionId} for signal ${context.signal.id}`);
    
    // Add context to memory
    this.memory.remember("sessionContext", context);
  }

  // Create execution plan using LLM reasoning
  async createExecutionPlan(): Promise<ExecutionPlan> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    const planPrompt = `Given the following session context, create an execution plan:

Signal: ${this.sessionContext.signal.id}
Signal Provider: ${this.sessionContext.signal.provider.name}
Payload: ${JSON.stringify(this.sessionContext.payload, null, 2)}

Available Agents:
${this.sessionContext.availableAgents.map(a => 
  `- ${a.id}: ${a.purpose}${a.capabilities ? '\n  Capabilities: ' + a.capabilities.join(', ') : ''}`
).join('\n')}

${this.sessionContext.additionalPrompts?.signal || ''}
${this.sessionContext.additionalPrompts?.session || ''}

Create an execution plan that:
1. Identifies which agents to use and in what order
2. Determines how data should flow between agents
3. Defines success criteria for the session
4. Specifies if the plan should be rigid or adaptive

For a telephone game, agents should transform the message sequentially.
For data processing, agents might work in parallel.
For complex tasks, multiple phases might be needed.

Respond with a structured plan.`;

    try {
      const response = await this.generateLLM(
        "claude-3-5-sonnet-20241022",
        this.prompts.system,
        planPrompt
      );

      // Parse the LLM response into ExecutionPlan
      return this.parseExecutionPlan(response);
    } catch (error) {
      this.log(`Error creating execution plan: ${error}`);
      // Fallback to a simple sequential plan
      return this.createDefaultPlan();
    }
  }

  // Parse LLM response into structured ExecutionPlan
  private parseExecutionPlan(llmResponse: string): ExecutionPlan {
    // For now, create a simple plan based on the response
    // In production, this would parse the structured output
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext!.sessionId,
      phases: [],
      successCriteria: ["All agents have processed the input successfully"],
      adaptationStrategy: 'flexible'
    };

    // Extract agent ordering from response
    const agents = this.sessionContext!.availableAgents;
    
    // For telephone game, create sequential phases
    if (this.sessionContext!.signal.id.includes('telephone')) {
      plan.phases.push({
        id: 'telephone-phase',
        name: 'Message Transformation',
        agents: agents.map((agent, index) => ({
          agentId: agent.id,
          task: `Transform the message using ${agent.name}`,
          inputSource: index === 0 ? 'signal' : 'previous',
          dependencies: index > 0 ? [agents[index - 1].id] : []
        })),
        executionStrategy: 'sequential'
      });
      
      // Update success criteria to be more specific for telephone game
      plan.successCriteria = [
        `All ${agents.length} agents must process the message in sequence`,
        'Each agent must transform the output of the previous agent',
        'The final output should be significantly different from the original'
      ];
    }

    this.executionPlan = plan;
    return plan;
  }

  // Create a default plan when LLM fails
  private createDefaultPlan(): ExecutionPlan {
    const agents = this.sessionContext!.availableAgents;
    
    return {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext!.sessionId,
      phases: [{
        id: 'default-phase',
        name: 'Default Processing',
        agents: agents.map(agent => ({
          agentId: agent.id,
          task: `Process signal with ${agent.id}`,
          inputSource: 'signal',
          dependencies: []
        })),
        executionStrategy: 'sequential'
      }],
      successCriteria: ["All agents executed"],
      adaptationStrategy: 'rigid'
    };
  }

  // Evaluate execution progress and determine next steps
  async evaluateProgress(results: AgentResult[]): Promise<{
    isComplete: boolean;
    nextAction?: 'continue' | 'retry' | 'adapt' | 'escalate';
    feedback?: string;
  }> {
    this.executionResults = results;

    const evaluationPrompt = `Evaluate the execution progress:

Original Signal: ${this.sessionContext!.signal.id}
Payload: ${JSON.stringify(this.sessionContext!.payload)}

Execution Plan:
- Total agents to execute: ${this.executionPlan!.phases.reduce((sum, phase) => sum + phase.agents.length, 0)}
- Agents executed so far: ${results.length}

Execution Results:
${results.map(r => 
  `Agent: ${r.agentId}
   Task: ${r.task}
   Input: ${JSON.stringify(r.input).slice(0, 100)}...
   Output: ${JSON.stringify(r.output).slice(0, 200)}...
   Duration: ${r.duration}ms`
).join('\n\n')}

Success Criteria:
${this.executionPlan!.successCriteria.join('\n')}

Determine:
1. Have ALL success criteria been met? (NOT just some)
2. Is the session goal FULLY achieved?
3. Should we continue to the next agent, or is the session complete?

IMPORTANT: The session is ONLY complete when ALL planned agents have executed successfully.

${this.sessionContext?.additionalPrompts?.evaluation || ''}

Provide a brief evaluation.`;

    try {
      const response = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        evaluationPrompt
      );

      // First check: Have all agents from execution plan actually executed?
      const totalAgentsInPlan = this.executionPlan!.phases.reduce((sum, phase) => sum + phase.agents.length, 0);
      const agentsExecuted = results.length;
      
      // If not all agents have executed, session cannot be complete regardless of LLM response
      if (agentsExecuted < totalAgentsInPlan) {
        return {
          isComplete: false,
          nextAction: 'continue',
          feedback: `${agentsExecuted}/${totalAgentsInPlan} agents executed. Continuing with next agent. LLM evaluation: ${response}`
        };
      }

      // All agents have executed - now check for quality/success via LLM
      const lowerResponse = response.toLowerCase();
      const hasFailures = (
        lowerResponse.includes('failed') ||
        lowerResponse.includes('error') ||
        lowerResponse.includes('unsuccessful')
      );
      
      return {
        isComplete: !hasFailures,
        nextAction: hasFailures ? 'retry' : undefined,
        feedback: response
      };
    } catch (error) {
      this.log(`Error evaluating progress: ${error}`);
      // Default to complete if all phases executed
      return {
        isComplete: results.length >= this.sessionContext!.availableAgents.length,
        feedback: "Evaluation completed based on execution count"
      };
    }
  }

  // Get execution summary for WorkspaceSupervisor
  getExecutionSummary(): {
    plan: ExecutionPlan | null;
    results: AgentResult[];
    status: 'planning' | 'executing' | 'completed' | 'failed';
  } {
    let status: 'planning' | 'executing' | 'completed' | 'failed' = 'planning';
    
    if (this.executionPlan && this.executionResults.length > 0) {
      const totalTasks = this.executionPlan.phases.reduce(
        (sum, phase) => sum + phase.agents.length, 0
      );
      
      if (this.executionResults.length >= totalTasks) {
        status = 'completed';
      } else {
        status = 'executing';
      }
    }

    return {
      plan: this.executionPlan,
      results: this.executionResults,
      status
    };
  }

  // Generate an intelligent summary of the session results
  async generateSessionSummary(phaseResults: any[]): Promise<string> {
    if (!this.sessionContext) {
      return "No session context available for summary.";
    }

    const allResults = phaseResults.flatMap(phase => phase.results);
    
    const summaryPrompt = `Summarize this session execution:

Signal: ${this.sessionContext.signal.id}
Original Input: ${JSON.stringify(this.sessionContext.payload)}

Agent Execution Chain:
${allResults.map((r, i) => `${i + 1}. ${r.agentId}:
   Input: ${JSON.stringify(r.input).slice(0, 100)}...
   Output: ${r.output}
   Duration: ${r.duration}ms`).join('\n\n')}

Session Goals: ${this.executionPlan?.successCriteria.join(', ') || 'Process signal through agents'}

Provide a concise but informative summary that:
1. Describes what happened in the session
2. Highlights key transformations or results
3. Notes whether the session goals were achieved
4. Mentions any interesting patterns or observations

Keep the summary focused and relevant to the specific use case.`;

    try {
      const summary = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        summaryPrompt
      );
      
      return summary;
    } catch (error) {
      this.log(`Error generating summary: ${error}`);
      return `Session completed with ${allResults.length} agent executions. Unable to generate AI summary.`;
    }
  }
}