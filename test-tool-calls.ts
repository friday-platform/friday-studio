#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

// Test script for ConversationSupervisor tool call simulation
import { LLMService } from "./src/core/llm-service.ts";

// Tool call simulation
interface ToolCall {
  id: string;
  type: "job_execution" | "agent_invocation" | "session_management" | "monitoring";
  name: string;
  parameters: Record<string, any>;
  result: string;
  duration: number;
}

class ConversationSupervisorReasoning {
  async analyzeRequest(
    message: string,
  ): Promise<
    {
      analysis: string;
      decision: string;
      confidence: number;
      duration: number;
      relevantAgents?: string[];
      recommendedJob?: string;
      executionStrategy?: string;
    }
  > {
    const startTime = Date.now();

    const prompt =
      `You are an Atlas ConversationSupervisor, part of a hierarchical AI agent orchestration platform. Your role is to analyze user requests and coordinate specialized AI agents through Atlas's session management system.

USER REQUEST: "${message}"

ATLAS PLATFORM CONTEXT:
You operate within Atlas, a comprehensive AI agent orchestration platform designed for autonomous software delivery. Atlas uses hierarchical supervision (WorkspaceRuntime → WorkspaceSupervisor → SessionSupervisor → AgentSupervisor) with LLM-enabled coordination.

AVAILABLE ATLAS AGENTS (LLM-powered, run in isolated Web Workers):
- security-agent: Security vulnerability analysis, penetration testing, code security review
  • Model: claude-3-5-haiku-20241022
  • Tools: static-analysis, dependency-scanner, crypto-analyzer
  • Purpose: "Specialized in identifying security vulnerabilities and architecture weaknesses"

- code-reviewer: Static code analysis, best practices, maintainability assessment  
  • Model: claude-3-5-haiku-20241022
  • Tools: ast-parser, complexity-analyzer, style-checker
  • Purpose: "Code quality analysis with focus on maintainability and best practices"

- architect: System architecture analysis, design patterns, scalability assessment
  • Model: claude-3-5-haiku-20241022  
  • Tools: architecture-scanner, dependency-mapper, pattern-detector
  • Purpose: "System design evaluation and architectural recommendations"

- performance-analyzer: Performance bottleneck detection, optimization recommendations
  • Model: claude-3-5-haiku-20241022
  • Tools: profiler, memory-analyzer, benchmark-runner
  • Purpose: "Performance optimization and bottleneck identification"

AVAILABLE ATLAS JOBS (Configured workflows with agent coordination):
- security-audit: 
  • Strategy: parallel
  • Agents: [security-agent, code-reviewer]
  • Description: "Comprehensive security review combining vulnerability scanning with code quality analysis"

- code-review:
  • Strategy: sequential  
  • Agents: [code-reviewer, architect]
  • Description: "Multi-perspective code quality analysis with architectural considerations"

- architecture-review:
  • Strategy: staged
  • Agents: [architect, performance-analyzer, security-agent]
  • Description: "System design evaluation covering architecture, performance, and security"

ANALYSIS REQUIREMENTS:
1. What is the user actually asking for?
2. Does this require single agent response or multi-agent coordination?
3. Which Atlas agents have the relevant capabilities?
4. Should I use an existing Atlas job or create custom agent coordination?
5. What Atlas execution strategy (sequential/parallel/staged) is most appropriate?
6. What's my confidence level given Atlas's agent capabilities?

CRITICAL: You must respond with ONLY valid JSON. No additional text before or after. Use this exact format:

{
  "analysis": "Your step-by-step thinking about the request in Atlas context",
  "decision": "What Atlas job/agents you've decided to coordinate",
  "relevantAgents": ["agent1", "agent2"],
  "recommendedJob": "job-name or null",
  "executionStrategy": "sequential/parallel/staged",
  "complexity": "low/medium/high", 
  "confidence": 0.85,
  "rationale": "Why this Atlas coordination approach is optimal"
}`;

    try {
      const response = await LLMService.generateText(prompt, {
        temperature: 0.1,
        model: "claude-3-5-haiku-20241022",
      });

      // Clean the response - sometimes LLMs add extra text
      const cleanedResponse = response.trim();
      let jsonStart = cleanedResponse.indexOf("{");
      let jsonEnd = cleanedResponse.lastIndexOf("}") + 1;

      if (jsonStart === -1 || jsonEnd === 0) {
        throw new Error("No JSON object found in response");
      }

      const jsonOnly = cleanedResponse.substring(jsonStart, jsonEnd);
      const result = JSON.parse(jsonOnly);

      return {
        analysis: result.analysis || "No analysis provided",
        decision: result.decision || "No decision made",
        confidence: typeof result.confidence === "number" ? result.confidence : 0.5,
        duration: Date.now() - startTime,
        relevantAgents: result.relevantAgents,
        recommendedJob: result.recommendedJob,
        executionStrategy: result.executionStrategy,
      };
    } catch (error) {
      return {
        analysis: `LLM analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        decision: "Fallback: Unable to analyze request",
        confidence: 0.1,
        duration: Date.now() - startTime,
      };
    }
  }

  // Simulate tool execution based on analysis
  async simulateToolExecution(
    analysisResult: any,
  ): Promise<{ toolCalls: ToolCall[]; duration: number }> {
    const startTime = Date.now();
    const toolCalls: ToolCall[] = [];

    // Only execute tools if LLM determined action is needed
    const needsExecution = analysisResult.recommendedJob ||
      (analysisResult.relevantAgents && analysisResult.relevantAgents.length > 0) ||
      (analysisResult.complexity && analysisResult.complexity !== "low");

    if (!needsExecution) {
      console.log("💭 No tool execution needed - informational response only");
      return {
        toolCalls: [],
        duration: Date.now() - startTime,
      };
    }

    console.log("🔧 Simulating Atlas tool execution...");

    // Simulate job execution if LLM recommended one
    if (analysisResult.recommendedJob) {
      const jobCall: ToolCall = {
        id: `job_${Date.now()}`,
        type: "job_execution",
        name: "trigger_atlas_job",
        parameters: {
          jobName: analysisResult.recommendedJob,
          executionStrategy: analysisResult.executionStrategy || "sequential",
        },
        result: `✅ Atlas job '${analysisResult.recommendedJob}' triggered successfully`,
        duration: 150 + Math.random() * 100,
      };
      toolCalls.push(jobCall);

      // Simulate delay
      await new Promise((resolve) => setTimeout(resolve, jobCall.duration));
      console.log(`   [1] ${jobCall.name} (${jobCall.duration.toFixed(0)}ms)`);
      console.log(`       📋 ${JSON.stringify(jobCall.parameters)}`);
      console.log(`       ✓ ${jobCall.result}`);
    }

    // Simulate agent invocations if LLM identified relevant agents
    if (analysisResult.relevantAgents && analysisResult.relevantAgents.length > 0) {
      for (let i = 0; i < analysisResult.relevantAgents.length; i++) {
        const agentId = analysisResult.relevantAgents[i];
        const agentCall: ToolCall = {
          id: `agent_${agentId}_${Date.now()}`,
          type: "agent_invocation",
          name: "invoke_atlas_agent",
          parameters: {
            agentId,
            task: `Process user request: "${analysisResult.decision}"`,
            context: "ConversationSupervisor coordination",
          },
          result: `🤖 Agent '${agentId}' started in isolated Web Worker`,
          duration: 200 + Math.random() * 150,
        };
        toolCalls.push(agentCall);

        // Simulate delay
        await new Promise((resolve) => setTimeout(resolve, agentCall.duration));
        console.log(
          `   [${toolCalls.length}] ${agentCall.name} (${agentCall.duration.toFixed(0)}ms)`,
        );
        console.log(`       📋 ${JSON.stringify(agentCall.parameters)}`);
        console.log(`       ✓ ${agentCall.result}`);
      }
    }

    // Only create session if we're actually executing agents/jobs
    if (toolCalls.length > 0) {
      const sessionCall: ToolCall = {
        id: `session_${Date.now()}`,
        type: "session_management",
        name: "create_workspace_session",
        parameters: {
          sessionType: "conversational",
          supervisorMode: "hierarchical",
          memoryEnabled: true,
        },
        result: `🎯 WorkspaceSession sess_${Math.random().toString(36).substring(2, 8)} created`,
        duration: 300 + Math.random() * 200,
      };
      toolCalls.push(sessionCall);

      await new Promise((resolve) => setTimeout(resolve, sessionCall.duration));
      console.log(
        `   [${toolCalls.length}] ${sessionCall.name} (${sessionCall.duration.toFixed(0)}ms)`,
      );
      console.log(`       📋 ${JSON.stringify(sessionCall.parameters)}`);
      console.log(`       ✓ ${sessionCall.result}`);

      // Only setup monitoring if we have a session
      const monitorCall: ToolCall = {
        id: `monitor_${Date.now()}`,
        type: "monitoring",
        name: "setup_session_monitoring",
        parameters: {
          realTimeLogging: true,
          performanceTracking: true,
          memoryTracking: true,
        },
        result: `📊 Real-time monitoring and LLM supervision enabled`,
        duration: 100 + Math.random() * 50,
      };
      toolCalls.push(monitorCall);

      await new Promise((resolve) => setTimeout(resolve, monitorCall.duration));
      console.log(
        `   [${toolCalls.length}] ${monitorCall.name} (${monitorCall.duration.toFixed(0)}ms)`,
      );
      console.log(`       📋 ${JSON.stringify(monitorCall.parameters)}`);
      console.log(`       ✓ ${monitorCall.result}`);
    }

    return {
      toolCalls,
      duration: Date.now() - startTime,
    };
  }
}

async function testToolCallSimulation() {
  console.log("🧠 Testing ConversationSupervisor Tool Call Simulation");
  console.log("=".repeat(60));

  const cs = new ConversationSupervisorReasoning();

  // Test messages
  const testMessages = [
    "What can Atlas do?",
    "Help me review the authentication code for security issues",
    "I need to optimize the database queries in my application",
    "Can you check if my microservices architecture is scalable?",
  ];

  for (let i = 0; i < testMessages.length; i++) {
    const message = testMessages[i];
    console.log(`\n👤 User: ${message}`);

    try {
      // LLM analysis
      console.log("🤔 Analyzing with LLM...");
      const analysisResult = await cs.analyzeRequest(message);

      console.log(`\n🧠 LLM Analysis (${analysisResult.duration}ms):`);
      console.log(`   ${analysisResult.analysis}`);
      console.log(`📊 Confidence: ${(analysisResult.confidence * 100).toFixed(0)}%`);
      console.log(`🎯 Decision: ${analysisResult.decision}`);

      if (analysisResult.relevantAgents) {
        console.log(`🤖 Selected Agents: ${analysisResult.relevantAgents.join(", ")}`);
      }

      if (analysisResult.recommendedJob) {
        console.log(`📋 Recommended Job: ${analysisResult.recommendedJob}`);
      }

      // Tool execution simulation
      console.log(`\n⚡ Executing Atlas tools...`);
      const toolExecution = await cs.simulateToolExecution(analysisResult);

      console.log(`\n✅ Tool execution completed (${toolExecution.duration}ms total)`);
      console.log(`   Executed ${toolExecution.toolCalls.length} tools successfully`);
    } catch (error) {
      console.error(`❌ Test failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (i < testMessages.length - 1) {
      console.log("\n" + "-".repeat(60));
    }
  }

  console.log("\n✅ All tests completed!");
}

// Run the test
if (import.meta.main) {
  await testToolCallSimulation();
}
