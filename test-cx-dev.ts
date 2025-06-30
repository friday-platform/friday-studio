#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

// Simple test script for ConversationSupervisor LLM reasoning
import { LLMService } from "./src/core/llm-service.ts";
import { checkDaemonRunning, getDaemonClient } from "./src/cli/utils/daemon-client.ts";
import { loadWorkspaceConfigNoCwd } from "./src/cli/modules/workspaces/resolver.ts";

// Types
interface ConversationContext {
  conversationId: string;
  workspaceId: string;
  participants: AgentInfo[];
  messageHistory: ConversationMessage[];
  workspaceConfig?: any;
}

interface AgentInfo {
  agentId: string;
  purpose: string;
  type: string;
}

interface ConversationMessage {
  id: string;
  type: string;
  content: { text?: string };
  timestamp: string;
}

interface InternalReasoningStep {
  stepId: string;
  timestamp: string;
  type: "request_analysis";
  output: {
    decision: string;
    selectedAgents?: string[];
    selectedJob?: string;
    confidenceLevel: number;
    expectedDuration?: number;
  };
  metadata: {
    duration: number;
    confidence: number;
    llmResponse?: string;
  };
}

class ConversationSupervisorReasoning {
  async analyzeRequest(
    message: string,
    context: ConversationContext,
  ): Promise<InternalReasoningStep> {
    const startTime = Date.now();

    const prompt =
      `You are a ConversationSupervisor analyzing a user request to coordinate AI agents.

USER REQUEST: "${message}"

AVAILABLE AGENTS:
${
        context.participants?.map((a) => `- ${a.agentId}: ${a.purpose}`).join("\n") ||
        "No agents configured"
      }

AVAILABLE JOBS:
${
        Object.entries(context.workspaceConfig?.jobs || {}).map(([name, job]: [string, any]) =>
          `- ${name}: ${job.description || "No description"}`
        ).join("\n") || "No jobs configured"
      }

CONVERSATION HISTORY:
${
        context.messageHistory.slice(-3).map((m) => `${m.type}: ${m.content.text || "N/A"}`).join(
          "\n",
        ) || "No previous messages"
      }

Analyze this request and decide how to handle it. Consider:
1. What is the user actually asking for?
2. Is this a simple question or complex multi-step task?
3. Which agents are most relevant?
4. Should I use an existing job template or custom coordination?
5. What's my confidence level in this analysis?

Respond with your reasoning process and decision in this JSON format:
{
  "analysis": "Your step-by-step thinking about the request",
  "decision": "What you've decided to do",
  "relevantAgents": ["agent1", "agent2"],
  "recommendedJob": "job-name or null",
  "complexity": "low/medium/high",
  "confidence": 0.85,
  "rationale": "Why you made this decision"
}`;

    try {
      console.log("🤔 Analyzing request with LLM...");
      const response = await LLMService.generateText(prompt, {
        temperature: 0.1,
        model: "claude-3-5-haiku-20241022",
      });

      const result = JSON.parse(response);

      return {
        stepId: `analysis_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: "request_analysis",
        output: {
          decision: result.decision,
          selectedAgents: result.relevantAgents,
          selectedJob: result.recommendedJob,
          confidenceLevel: result.confidence,
          expectedDuration: this.estimateDuration(result.complexity),
        },
        metadata: {
          duration: Date.now() - startTime,
          confidence: result.confidence,
          llmResponse: result.analysis,
        },
      };
    } catch (error) {
      console.error("❌ LLM analysis failed:", error);
      return this.createFallbackAnalysis(message, context, startTime);
    }
  }

  private estimateDuration(complexity: string): number {
    const durations = { low: 15000, medium: 45000, high: 120000 };
    return durations[complexity as keyof typeof durations] || 45000;
  }

  private createFallbackAnalysis(
    message: string,
    context: ConversationContext,
    startTime: number,
  ): InternalReasoningStep {
    return {
      stepId: `fallback_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "request_analysis",
      output: {
        decision: "LLM analysis failed, using fallback logic",
        selectedAgents: context.participants.slice(0, 1).map((a) => a.agentId),
        confidenceLevel: 0.5,
        expectedDuration: 30000,
      },
      metadata: {
        duration: Date.now() - startTime,
        confidence: 0.5,
        llmResponse: "Fallback: Basic request handling without LLM analysis",
      },
    };
  }
}

async function testConversationSupervisor() {
  console.log("🧠 Testing ConversationSupervisor LLM Reasoning");
  console.log("=".repeat(50));

  try {
    // Check daemon
    if (!(await checkDaemonRunning())) {
      console.error("❌ Daemon not running. Start with 'atlas daemon start'");
      return;
    }

    // Use a known good workspace
    const workspacePath =
      "/Users/kenneth/tempest/atlas/examples/workspaces/atlas-codebase-analyzer";
    console.log(`✅ Using workspace: Atlas Codebase Analyzer`);

    // Load config
    const config = await loadWorkspaceConfigNoCwd(workspacePath);

    const participants: AgentInfo[] = Object.entries(config.agents || {}).map((
      [id, agent]: [string, any],
    ) => ({
      agentId: id,
      purpose: agent.purpose || "No purpose defined",
      type: agent.type || "unknown",
    }));

    console.log(`📋 Available agents: ${participants.length}`);
    console.log(`📋 Available jobs: ${Object.keys(config.jobs || {}).length}`);

    // Create context
    const context: ConversationContext = {
      conversationId: `test-${Date.now()}`,
      workspaceId: "atlas-codebase-analyzer",
      participants,
      messageHistory: [],
      workspaceConfig: config,
    };

    // Initialize reasoning
    const cs = new ConversationSupervisorReasoning();

    // Test message
    const testMessage = "Help me review the authentication code for security issues";
    console.log(`\n👤 User: ${testMessage}`);

    // Analyze with LLM
    const analysis = await cs.analyzeRequest(testMessage, context);

    // Display results
    console.log(`\n🧠 LLM Analysis (${analysis.metadata.duration}ms):`);
    console.log(`${analysis.metadata.llmResponse}`);
    console.log(`\n📊 Confidence: ${(analysis.output.confidenceLevel * 100).toFixed(0)}%`);
    console.log(`🎯 Decision: ${analysis.output.decision}`);

    if (analysis.output.selectedAgents && analysis.output.selectedAgents.length > 0) {
      console.log(`🤖 Selected Agents: ${analysis.output.selectedAgents.join(", ")}`);
    }

    if (analysis.output.selectedJob) {
      console.log(`📋 Recommended Job: ${analysis.output.selectedJob}`);
    }

    console.log("\n✅ Test completed successfully!");
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

// Run the test
if (import.meta.main) {
  await testConversationSupervisor();
}
