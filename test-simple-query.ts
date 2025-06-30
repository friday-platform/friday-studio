#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

// Simple test for informational queries
import { LLMService } from "./src/core/llm-service.ts";

const prompt =
  `You are an Atlas ConversationSupervisor, part of a hierarchical AI agent orchestration platform. Your role is to analyze user requests and coordinate specialized AI agents through Atlas's session management system.

USER REQUEST: "Hello"

ATLAS PLATFORM CONTEXT:
You operate within Atlas, a comprehensive AI agent orchestration platform designed for autonomous software delivery. Atlas uses hierarchical supervision (WorkspaceRuntime → WorkspaceSupervisor → SessionSupervisor → AgentSupervisor) with LLM-enabled coordination.

AVAILABLE ATLAS AGENTS (LLM-powered, run in isolated Web Workers):
- security-agent: Security vulnerability analysis, penetration testing, code security review
- code-reviewer: Static code analysis, best practices, maintainability assessment  
- architect: System architecture analysis, design patterns, scalability assessment
- performance-analyzer: Performance bottleneck detection, optimization recommendations

AVAILABLE ATLAS JOBS (Configured workflows with agent coordination):
- security-audit: Comprehensive security review combining vulnerability scanning with code quality analysis
- code-review: Multi-perspective code quality analysis with architectural considerations
- architecture-review: System design evaluation covering architecture, performance, and security

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

console.log("Testing simple greeting...");

try {
  const response = await LLMService.generateText(prompt, {
    temperature: 0.1,
    model: "claude-3-5-haiku-20241022",
  });

  console.log("LLM Response:");
  console.log(response);

  const cleanedResponse = response.trim();
  let jsonStart = cleanedResponse.indexOf("{");
  let jsonEnd = cleanedResponse.lastIndexOf("}") + 1;

  if (jsonStart !== -1 && jsonEnd > 0) {
    const jsonOnly = cleanedResponse.substring(jsonStart, jsonEnd);
    const result = JSON.parse(jsonOnly);

    console.log("\nParsed Analysis:");
    console.log(`- Complexity: ${result.complexity}`);
    console.log(`- Recommended Job: ${result.recommendedJob || "None"}`);
    console.log(`- Relevant Agents: ${result.relevantAgents?.join(", ") || "None"}`);
    console.log(`- Decision: ${result.decision}`);

    const needsExecution = result.recommendedJob ||
      (result.relevantAgents && result.relevantAgents.length > 0) ||
      (result.complexity && result.complexity !== "low");

    console.log(`\nWould execute tools: ${needsExecution ? "YES" : "NO"}`);
  }
} catch (error) {
  console.error("Error:", error);
}
