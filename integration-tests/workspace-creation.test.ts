/**
 * Integration Test Suite for Advanced Workspace Creation (Part 1)
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { WorkspaceConfigSchema } from "@atlas/config";
import { generateWorkspace } from "../packages/tools/src/internal/workspace-creation/generation.ts";

// Realistic test scenarios for comprehensive validation
const testScenarios = [
  {
    name: "Nike shoe monitoring",
    userIntent: "Monitor Nike for new shoe drops and send Discord notifications",
    conversationContext:
      "User wants automated monitoring every 30 minutes. Has Discord webhook URL available. " +
      "Interested in tracking new releases and rating hype level. Prefers notifications in #sneakers channel.",
    requirements: {
      triggers: ["schedule - every 30 minutes"],
      integrations: ["Nike website scraping", "Discord webhook"],
      outputs: ["Discord channel notifications"],
      credentials: ["Discord webhook URL"],
    },
    expectedComponents: {
      minSignals: 1,
      minAgents: 2, // scraper + notifier
      minJobs: 1,
      shouldHaveSchedule: true,
      shouldHaveWebhook: false,
    },
  },
  {
    name: "GitHub release monitoring",
    userIntent: "Monitor GitHub releases for my repositories and send email alerts",
    conversationContext: "User wants to track new releases across multiple repositories. " +
      "Needs email notifications with release notes summary. Should check every hour during business hours.",
    requirements: {
      triggers: ["schedule - hourly during business hours"],
      integrations: ["GitHub API", "Email notifications"],
      outputs: ["Email alerts with release summaries"],
      credentials: ["GitHub API token", "Email configuration"],
    },
    expectedComponents: {
      minSignals: 1,
      minAgents: 2, // GitHub monitor + email sender
      minJobs: 1,
      shouldHaveSchedule: true,
      shouldHaveWebhook: false,
    },
  },
  {
    name: "Stripe-HubSpot customer sync",
    userIntent: "Sync new Stripe customers to HubSpot with AI enrichment",
    conversationContext:
      "User wants real-time customer data sync when new customers are created in Stripe. " +
      "Wants AI to enrich customer profiles before sending to HubSpot. Should include company analysis.",
    requirements: {
      triggers: ["Stripe webhook"],
      integrations: ["Stripe API", "HubSpot API", "AI analysis"],
      outputs: ["HubSpot contact creation"],
      credentials: ["Stripe webhook secret", "HubSpot API token"],
    },
    expectedComponents: {
      minSignals: 1,
      minAgents: 3, // validator + enricher + sync
      minJobs: 1,
      shouldHaveSchedule: false,
      shouldHaveWebhook: true,
    },
  },
  {
    name: "Daily report generation",
    userIntent: "Generate daily sales reports with data from multiple sources",
    conversationContext:
      "User wants automated daily reports combining Stripe payments, Google Analytics, and Slack activity. " +
      "Should run every morning at 9 AM EST and send to management team via email.",
    requirements: {
      triggers: ["schedule - daily at 9 AM EST"],
      integrations: ["Stripe API", "Google Analytics", "Email"],
      outputs: ["PDF report via email"],
      credentials: ["Stripe API key", "Google Analytics credentials", "Email SMTP"],
    },
    expectedComponents: {
      minSignals: 1,
      minAgents: 4, // data collectors + analyzer + report generator
      minJobs: 1,
      shouldHaveSchedule: true,
      shouldHaveWebhook: false,
    },
  },
  {
    name: "API integration webhook",
    userIntent: "Process incoming webhook data from external service and transform it",
    conversationContext: "User receives webhook notifications from a third-party CRM system. " +
      "Needs to validate, transform, and forward the data to multiple internal systems.",
    requirements: {
      triggers: ["HTTP webhook"],
      integrations: ["External CRM", "Internal database", "Notification system"],
      outputs: ["Database updates", "Internal notifications"],
      credentials: ["Webhook secret", "Database credentials"],
    },
    expectedComponents: {
      minSignals: 1,
      minAgents: 3, // validator + transformer + forwarder
      minJobs: 1,
      shouldHaveSchedule: false,
      shouldHaveWebhook: true,
    },
  },
];

// Skip these tests in CI or when no API key is available (they require real LLM)
const skipIfNoKey = !Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("CI") === "true" ||
  Deno.env.get("ATLAS_USE_LLM_MOCKS") === "true";

// Test each scenario with comprehensive validation
for (const scenario of testScenarios) {
  Deno.test({
    name: `Integration: ${scenario.name}`,
    ignore: skipIfNoKey,
    fn: async () => {
      // Verify API key is available
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable not set. Run with: deno task test");
      }

      console.log(`\n🚀 === STARTING INTEGRATION TEST: ${scenario.name} ===`);
      console.log(`📝 Intent: ${scenario.userIntent}`);
      console.log(`💬 Context: ${scenario.conversationContext}`);
      console.log(`📋 Requirements:`, JSON.stringify(scenario.requirements, null, 2));

      // Execute workspace generation
      console.log(`\n⏱️  Starting workspace generation...`);
      const startTime = Date.now();

      let result;
      try {
        result = await generateWorkspace.execute!({
          workspaceName: scenario.name,
          // In tests we don't actually want to create the workspace.
          createWorkspace: false,
          userIntent: scenario.userIntent,
          conversationContext: scenario.conversationContext,
          requirements: scenario.requirements,
          debugLevel: "detailed",
        }, {
          toolCallId: "test-integration-call-id",
          messages: [],
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        console.log(`❌ Generation FAILED after ${duration}ms`);
        console.log(`🔥 Error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }

      const duration = Date.now() - startTime;
      console.log(`✅ Generation completed in ${duration}ms`);
      console.log(`🎯 Success: ${result.success}`);
      if (result.reasoning) {
        console.log(`🧠 Reasoning: ${result.reasoning}`);
      }

      // Validate successful generation
      assertEquals(result.success, true);
      assertExists(result.config);
      assertExists(result.workspaceName);
      assertStringIncludes(result.reasoning, "Success");

      // Performance validation (<30 seconds as per plan)
      if (duration > 30000) {
        console.warn(`⚠️  Generation took ${duration}ms (>30s target)`);
      }

      // Schema compliance validation using authoritative schema
      console.log(`\n🔍 === WORKSPACE CONFIGURATION ANALYSIS ===`);
      console.log(`📁 Workspace Name: ${result.config.workspace?.name || "MISSING"}`);
      console.log(`📄 Description: ${result.config.workspace?.description || "MISSING"}`);
      console.log(`🏷️  Version: ${result.config.version || "MISSING"}`);

      console.log(`\n⚙️  Validating schema compliance...`);
      const validatedConfig = WorkspaceConfigSchema.parse(result.config);
      console.log(`✅ Schema validation passed`);

      assertExists(validatedConfig);
      assertExists(validatedConfig.workspace.name);
      assertEquals(validatedConfig.version, "1.0");

      // Basic structure validation
      assertExists(validatedConfig.signals);
      assertExists(validatedConfig.jobs);
      assertExists(validatedConfig.agents);

      // Component count validation
      const signalCount = Object.keys(validatedConfig.signals || {}).length;
      const agentCount = Object.keys(validatedConfig.agents || {}).length;
      const jobCount = Object.keys(validatedConfig.jobs || {}).length;

      console.log(`\n📊 === COMPONENT SUMMARY ===`);
      console.log(`🔔 Signals: ${signalCount}`);
      console.log(`🤖 Agents: ${agentCount}`);
      console.log(`⚡ Jobs: ${jobCount}`);

      // Detailed component breakdown
      if (signalCount > 0) {
        console.log(`\n🔔 === SIGNALS DETAILS ===`);
        for (const [name, signal] of Object.entries(validatedConfig.signals || {})) {
          console.log(`  📡 ${name}:`);
          console.log(`     Provider: ${signal.provider}`);
          console.log(`     Description: ${signal.description}`);
          if ("config" in signal && signal.config) {
            console.log(`     Config: ${JSON.stringify(signal.config, null, 6)}`);
          }
        }
      }

      if (agentCount > 0) {
        console.log(`\n🤖 === AGENTS DETAILS ===`);
        for (const [id, agent] of Object.entries(validatedConfig.agents || {})) {
          console.log(`  👤 ${id}:`);
          console.log(`     Type: ${agent.type}`);
          console.log(`     Description: ${agent.description}`);
          if (agent.type === "llm" && agent.config) {
            console.log(`     Provider: ${agent.config.provider}`);
            console.log(`     Model: ${agent.config.model}`);
            console.log(`     Temperature: ${agent.config.temperature}`);
            console.log(`     Tools: [${agent.config.tools?.join(", ") || "none"}]`);
          } else if (agent.type === "system") {
            console.log(`     Agent: ${agent.agent}`);
          }
        }
      }

      if (jobCount > 0) {
        console.log(`\n⚡ === JOBS DETAILS ===`);
        for (const [name, job] of Object.entries(validatedConfig.jobs || {})) {
          console.log(`  🔧 ${name}:`);
          console.log(`     Description: ${job.description || "N/A"}`);
          console.log(`     Strategy: ${job.execution?.strategy || "N/A"}`);
          console.log(
            `     Triggers: [${job.triggers?.map((t) => t.signal).join(", ") || "none"}]`,
          );
          console.log(`     Agents: [${job.execution?.agents?.join(", ") || "none"}]`);
        }
      }

      if (validatedConfig.tools?.mcp?.servers) {
        const mcpCount = Object.keys(validatedConfig.tools.mcp.servers).length;
        console.log(`\n🔌 === MCP INTEGRATIONS (${mcpCount}) ===`);
        for (const [name, server] of Object.entries(validatedConfig.tools.mcp.servers)) {
          console.log(`  🖥️  ${name}:`);
          console.log(`     Transport: ${server.transport?.type}`);
          if (server.transport?.type === "stdio" && "command" in server.transport) {
            console.log(`     Command: ${server.transport.command}`);
          }
        }
      }

      console.log(`\n✅ === COMPONENT COUNT VALIDATION ===`);
      console.log(
        `🔔 Signals: ${signalCount} >= ${scenario.expectedComponents.minSignals} required`,
      );
      console.log(`🤖 Agents: ${agentCount} >= ${scenario.expectedComponents.minAgents} required`);
      console.log(`⚡ Jobs: ${jobCount} >= ${scenario.expectedComponents.minJobs} required`);

      if (signalCount < scenario.expectedComponents.minSignals) {
        console.log(
          `❌ SIGNAL COUNT FAILURE: Expected at least ${scenario.expectedComponents.minSignals} signals, got ${signalCount}`,
        );
        throw new Error(
          `Expected at least ${scenario.expectedComponents.minSignals} signals, got ${signalCount}`,
        );
      }
      if (agentCount < scenario.expectedComponents.minAgents) {
        console.log(
          `❌ AGENT COUNT FAILURE: Expected at least ${scenario.expectedComponents.minAgents} agents, got ${agentCount}`,
        );
        throw new Error(
          `Expected at least ${scenario.expectedComponents.minAgents} agents, got ${agentCount}`,
        );
      }
      if (jobCount < scenario.expectedComponents.minJobs) {
        console.log(
          `❌ JOB COUNT FAILURE: Expected at least ${scenario.expectedComponents.minJobs} jobs, got ${jobCount}`,
        );
        throw new Error(
          `Expected at least ${scenario.expectedComponents.minJobs} jobs, got ${jobCount}`,
        );
      }
      console.log(`✅ All component counts meet requirements`);

      // Signal type validation
      console.log(`\n🔍 === SIGNAL TYPE VALIDATION ===`);
      const signals = Object.values(validatedConfig.signals || {});
      const hasScheduleSignal = signals.some((s) => s.provider === "schedule");
      const hasWebhookSignal = signals.some((s) => s.provider === "http");

      console.log(`📅 Schedule signals: ${hasScheduleSignal ? "✅ Found" : "❌ Missing"}`);
      console.log(`🌐 Webhook signals: ${hasWebhookSignal ? "✅ Found" : "❌ Missing"}`);
      console.log(
        `🎯 Schedule required: ${scenario.expectedComponents.shouldHaveSchedule ? "Yes" : "No"}`,
      );
      console.log(
        `🎯 Webhook required: ${scenario.expectedComponents.shouldHaveWebhook ? "Yes" : "No"}`,
      );

      if (scenario.expectedComponents.shouldHaveSchedule && !hasScheduleSignal) {
        console.log(`❌ SIGNAL TYPE FAILURE: Expected schedule signal but none found`);
        throw new Error("Expected schedule signal but none found");
      }
      if (scenario.expectedComponents.shouldHaveWebhook && !hasWebhookSignal) {
        console.log(`❌ SIGNAL TYPE FAILURE: Expected webhook signal but none found`);
        throw new Error("Expected webhook signal but none found");
      }
      console.log(`✅ Signal types meet requirements`);

      // Reference integrity validation - critical for workspace functionality
      console.log(`\n🔗 === REFERENCE INTEGRITY VALIDATION ===`);
      const referenceErrors = [];

      for (const [jobName, job] of Object.entries(validatedConfig.jobs || {})) {
        console.log(`\n🔧 Checking job: ${jobName}`);

        // Check signal references
        console.log(`  🔔 Signal references:`);
        for (const trigger of job.triggers || []) {
          const signalExists = validatedConfig.signals?.[trigger.signal];
          console.log(`    📡 ${trigger.signal}: ${signalExists ? "✅ Found" : "❌ NOT FOUND"}`);

          if (!signalExists) {
            const availableSignals = Object.keys(validatedConfig.signals || {});
            console.log(`    🔍 Available signals: [${availableSignals.join(", ")}]`);
            referenceErrors.push(
              `Job '${jobName}' references undefined signal '${trigger.signal}'`,
            );
          }
        }

        // Check agent references
        console.log(`  🤖 Agent references:`);
        for (const agent of job.execution?.agents || []) {
          const agentId = typeof agent === "string" ? agent : agent.id;
          const agentExists = validatedConfig.agents?.[agentId];
          console.log(`    👤 ${agentId}: ${agentExists ? "✅ Found" : "❌ NOT FOUND"}`);

          if (!agentExists) {
            const availableAgents = Object.keys(validatedConfig.agents || {});
            console.log(`    🔍 Available agents: [${availableAgents.join(", ")}]`);
            referenceErrors.push(`Job '${jobName}' references undefined agent '${agentId}'`);
          }
        }
      }

      if (referenceErrors.length > 0) {
        console.log(`\n❌ REFERENCE INTEGRITY FAILURES:`);
        referenceErrors.forEach((error, i) => console.log(`  ${i + 1}. ${error}`));
        throw new Error(`Reference integrity validation failed: ${referenceErrors.join("; ")}`);
      }

      console.log(`✅ All references are valid`);

      // Agent configuration validation
      console.log(`\n🤖 === AGENT CONFIGURATION VALIDATION ===`);
      const agentConfigErrors = [];

      for (const [agentId, agent] of Object.entries(validatedConfig.agents || {})) {
        console.log(`\n👤 Validating agent: ${agentId}`);

        if (!agent.type) {
          console.log(`  ❌ Missing type`);
          agentConfigErrors.push(`Agent '${agentId}' missing type`);
        } else {
          console.log(`  ✅ Type: ${agent.type}`);
        }

        if (!agent.description) {
          console.log(`  ❌ Missing description`);
          agentConfigErrors.push(`Agent '${agentId}' missing description`);
        } else {
          console.log(`  ✅ Description: Present`);
        }

        // Validate LLM agents have proper configuration
        if (agent.type === "llm") {
          console.log(`  🧠 LLM-specific validation:`);
          if (!agent.config) {
            console.log(`    ❌ Missing config object`);
            agentConfigErrors.push(`LLM agent '${agentId}' missing config`);
          } else {
            console.log(`    ✅ Config object: Present`);

            if (!agent.config.provider) {
              console.log(`    ❌ Missing provider`);
              agentConfigErrors.push(`LLM agent '${agentId}' missing provider`);
            } else {
              console.log(`    ✅ Provider: ${agent.config.provider}`);
            }

            if (!agent.config.model) {
              console.log(`    ❌ Missing model`);
              agentConfigErrors.push(`LLM agent '${agentId}' missing model`);
            } else {
              console.log(`    ✅ Model: ${agent.config.model}`);
            }

            if (!agent.config.prompt) {
              console.log(`    ❌ Missing prompt`);
              agentConfigErrors.push(`LLM agent '${agentId}' missing prompt`);
            } else {
              console.log(`    ✅ Prompt: Present (${agent.config.prompt.length} chars)`);
            }
          }
        } else if (agent.type === "remote") {
          console.log(`  🌐  Remote agent - validation passed`);
        }
      }

      if (agentConfigErrors.length > 0) {
        console.log(`\n❌ AGENT CONFIGURATION FAILURES:`);
        agentConfigErrors.forEach((error, i) => console.log(`  ${i + 1}. ${error}`));
        throw new Error(`Agent configuration validation failed: ${agentConfigErrors.join("; ")}`);
      }

      console.log(`✅ All agent configurations are valid`);

      // Job execution strategy validation
      console.log(`\n⚡ === JOB EXECUTION VALIDATION ===`);
      const jobExecutionErrors = [];

      for (const [jobName, job] of Object.entries(validatedConfig.jobs || {})) {
        console.log(`\n🔧 Validating job: ${jobName}`);

        if (!job.execution?.strategy) {
          console.log(`  ❌ Missing execution strategy`);
          jobExecutionErrors.push(`Job '${jobName}' missing execution strategy`);
        } else {
          const strategy = job.execution.strategy;
          console.log(`  ✅ Execution strategy: ${strategy}`);

          if (strategy !== "sequential" && strategy !== "parallel") {
            console.log(`  ❌ Invalid strategy: ${strategy}`);
            jobExecutionErrors.push(`Job '${jobName}' has invalid execution strategy: ${strategy}`);
          }
        }

        // Validate agents array is not empty
        const agents = job.execution?.agents || [];
        if (agents.length === 0) {
          console.log(`  ❌ No agents defined`);
          jobExecutionErrors.push(`Job '${jobName}' has no agents defined`);
        } else {
          console.log(`  ✅ Agents defined: ${agents.length} agent(s)`);
        }
      }

      if (jobExecutionErrors.length > 0) {
        console.log(`\n❌ JOB EXECUTION FAILURES:`);
        jobExecutionErrors.forEach((error, i) => console.log(`  ${i + 1}. ${error}`));
        throw new Error(`Job execution validation failed: ${jobExecutionErrors.join("; ")}`);
      }

      console.log(`✅ All job execution strategies are valid`);

      // Save configuration for inspection
      const outputPath = `./test-output-integration-${scenario.name.replace(/\s+/g, "-")}.json`;
      await Deno.writeTextFile(
        outputPath,
        JSON.stringify(
          {
            scenario: scenario.name,
            userIntent: scenario.userIntent,
            requirements: scenario.requirements,
            testType: "integration",
            generationTime: duration,
            reasoning: result.reasoning,
            config: result.config,
            validation: {
              schemaCompliant: true,
              referenceIntegrity: true,
              componentCounts: {
                signals: signalCount,
                agents: agentCount,
                jobs: jobCount,
              },
              signalTypes: {
                schedule: hasScheduleSignal,
                webhook: hasWebhookSignal,
              },
            },
          },
          null,
          2,
        ),
      );

      console.log(`\n🎉 === INTEGRATION TEST SUMMARY ===`);
      console.log(`✅ Test: ${scenario.name}`);
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(
        `🔔 Signals: ${signalCount} (${scenario.expectedComponents.minSignals} required)`,
      );
      console.log(`🤖 Agents: ${agentCount} (${scenario.expectedComponents.minAgents} required)`);
      console.log(`⚡ Jobs: ${jobCount} (${scenario.expectedComponents.minJobs} required)`);
      console.log(`🎯 Success: ${result.success}`);
      console.log(`📁 Results saved to: ${outputPath}`);
      console.log(`🏆 INTEGRATION TEST PASSED! 🏆\n`);
    },
  });
}
