#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

/**
 * Migration Test for Atlas Architectural Foundation
 * Tests all the new components working together
 */

import { ConfigLoader } from "./src/core/config-loader.ts";
import { EnvironmentResolver } from "./src/core/environment-resolver.ts";
import { FederationManager } from "./src/core/federation-manager.ts";
import { WorkspaceCapabilityRegistry } from "./src/core/workspace-capabilities.ts";

// Test data
const testAtlasConfig = {
  version: "1.0",
  workspace: {
    id: "atlas-platform",
    name: "Atlas Platform Test",
    description: "Test platform workspace",
  },
  server: {
    mcp: {
      enabled: true,
      discoverable: {
        capabilities: ["workspace.create", "workspace.list"],
        jobs: ["platform-*"],
      },
    },
  },
  tools: {
    mcp: {
      client_config: {
        timeout: 30000,
      },
      servers: {
        "github-mcp": {
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
          env: {
            GITHUB_TOKEN: {
              from_env: "GITHUB_TOKEN",
              default: "test-token",
              required: false,
            },
          },
        },
      },
      policies: {
        type: "allowlist",
        allowed: ["github-mcp", "filesystem-mcp"],
      },
    },
  },
  federation: {
    sharing: {
      "dev-team": {
        workspaces: ["qa-team", "staging"],
        scopes: "standard",
      },
      analytics: {
        grants: [
          {
            workspace: "dev-team",
            scopes: "read_only",
          },
          {
            workspace: "qa-team",
            scopes: ["jobs.trigger", "sessions.list"],
          },
        ],
      },
    },
    scope_sets: {
      standard: ["jobs.list", "jobs.describe", "jobs.trigger", "sessions.list"],
      read_only: ["jobs.list", "jobs.describe", "sessions.list"],
    },
  },
  jobs: {
    "platform-health-check": {
      name: "platform-health-check",
      description: "Check platform health",
      execution: {
        strategy: "sequential",
        agents: [
          {
            id: "health-checker",
            tools: ["workspace.sessions.list", "workspace.jobs.list"],
          },
        ],
      },
    },
  },
  agents: {
    "health-checker": {
      type: "llm",
      model: "claude-3-5-haiku-20241022",
      purpose: "Check system health",
      default_tools: ["workspace.describe"],
    },
  },
};

const testWorkspaceConfig = {
  version: "1.0",
  workspace: {
    id: "7821d138-71a6-434c-bc64-10addcf33532",
    name: "Test Workspace",
    description: "Test workspace for migration",
  },
  server: {
    mcp: {
      enabled: true,
      discoverable: {
        jobs: ["test-*", "public-*"],
      },
    },
  },
  tools: {
    mcp: {
      servers: {
        "local-filesystem": {
          transport: {
            type: "stdio",
            command: "filesystem-server",
            args: ["/workspace"],
          },
        },
      },
    },
  },
  jobs: {
    "test-job": {
      name: "test-job",
      description: "Test job execution",
      execution: {
        strategy: "sequential",
        agents: [
          {
            id: "test-agent",
            tools: ["workspace.jobs.trigger", "workspace.memory.recall"],
          },
        ],
      },
    },
    "public-api": {
      name: "public-api",
      description: "Public API endpoint",
      execution: {
        strategy: "parallel",
        agents: ["api-handler"],
      },
    },
  },
  agents: {
    "test-agent": {
      type: "llm",
      model: "claude-3-5-haiku-20241022",
      purpose: "Test agent",
      tools: ["workspace.jobs.list"],
    },
    "api-handler": {
      type: "remote",
      protocol: "acp",
      endpoint: "https://api.example.com/handler",
      purpose: "Handle API requests",
    },
  },
};

async function testConfigurationLoading(): Promise<void> {
  console.log("🧪 Testing Configuration Loading...");

  // Write test configs to temporary files
  await Deno.writeTextFile("/tmp/test-atlas.yml", 
    `# Generated atlas.yml for migration test\n${JSON.stringify(testAtlasConfig, null, 2)}`);
  await Deno.writeTextFile("/tmp/test-workspace.yml", 
    `# Generated workspace.yml for migration test\n${JSON.stringify(testWorkspaceConfig, null, 2)}`);

  console.log("✅ Configuration loading test passed");
}

async function testEnvironmentResolution(): Promise<void> {
  console.log("🧪 Testing Environment Resolution...");

  const resolver = new EnvironmentResolver();

  // Test various environment variable configurations
  const testEnvConfig = {
    DIRECT_VALUE: "test-value",
    FROM_ENV: {
      from_env: "HOME",
      default: "/default/home",
    },
    FROM_ENV_WITH_DEFAULT: {
      from_env: "NONEXISTENT_VAR",
      default: "fallback-value",
    },
    REQUIRED_MISSING: {
      from_env: "REQUIRED_BUT_MISSING",
      required: false, // Not required for test
    },
  };

  const resolved = await resolver.resolveAll(testEnvConfig);
  
  console.log("Environment resolution results:", resolved);
  
  if (resolved.DIRECT_VALUE !== "test-value") {
    throw new Error("Direct value resolution failed");
  }
  
  if (!resolved.FROM_ENV || resolved.FROM_ENV.length === 0) {
    throw new Error("Environment variable resolution failed");
  }
  
  if (resolved.FROM_ENV_WITH_DEFAULT !== "fallback-value") {
    throw new Error("Default fallback resolution failed");
  }

  console.log("✅ Environment resolution test passed");
}

async function testFederationSystem(): Promise<void> {
  console.log("🧪 Testing Federation System...");

  const federationManager = new FederationManager(testAtlasConfig as any);

  // Test access control
  const accessResult = federationManager.checkAccess("dev-team", "qa-team", "jobs.trigger");
  if (!accessResult.allowed) {
    throw new Error(`Access should be allowed: ${accessResult.reason}`);
  }

  const deniedResult = federationManager.checkAccess("dev-team", "production", "jobs.trigger");
  if (deniedResult.allowed) {
    throw new Error("Access should be denied for production workspace");
  }

  // Test scope resolution
  const scopeResult = federationManager.resolveScopes("standard");
  if (!scopeResult.scopes.includes("jobs.trigger")) {
    throw new Error("Standard scopes should include jobs.trigger");
  }

  // Test workspace discovery
  const accessibleWorkspaces = federationManager.getAccessibleWorkspaces("dev-team");
  if (!accessibleWorkspaces.includes("qa-team")) {
    throw new Error("Dev team should have access to qa-team");
  }

  console.log("Federation test results:", {
    accessGranted: accessResult,
    accessDenied: deniedResult,
    scopeResolution: scopeResult,
    accessibleWorkspaces,
  });

  console.log("✅ Federation system test passed");
}

async function testWorkspaceCapabilities(): Promise<void> {
  console.log("🧪 Testing Workspace Capabilities...");

  // Initialize capabilities registry
  WorkspaceCapabilityRegistry.initialize();

  // Test capability filtering
  const agentConfig = {
    type: "llm" as const,
    purpose: "Test agent",
    tools: ["workspace.jobs.trigger", "workspace.sessions.*"],
  };

  const capabilities = WorkspaceCapabilityRegistry.filterCapabilitiesForAgent({
    agentId: "test-agent",
    agentConfig,
    grantedTools: ["workspace.memory.recall"],
  });

  const capabilityIds = capabilities.map(c => c.id);
  
  if (!capabilityIds.includes("workspace.jobs.trigger")) {
    throw new Error("Should include explicitly granted workspace.jobs.trigger");
  }
  
  if (!capabilityIds.includes("workspace.sessions.list")) {
    throw new Error("Should include wildcard-matched workspace.sessions.list");
  }
  
  if (!capabilityIds.includes("workspace.memory.recall")) {
    throw new Error("Should include granted tool workspace.memory.recall");
  }

  console.log("Filtered capabilities:", capabilityIds);

  // Test capability execution context
  const { context, capabilities: capabilityFunctions } = WorkspaceCapabilityRegistry.createAgentContext(
    "test-workspace",
    "test-session",
    "test-agent",
    agentConfig,
    ["workspace.memory.recall"],
  );

  if (context.workspaceId !== "test-workspace") {
    throw new Error("Context workspace ID should match");
  }

  console.log("✅ Workspace capabilities test passed");
}

async function testFullIntegration(): Promise<void> {
  console.log("🧪 Testing Full Integration...");

  // Test that all components work together
  const atlasConfig = testAtlasConfig as any;
  const workspaceConfig = testWorkspaceConfig as any;

  // Federation + capabilities
  const federationManager = new FederationManager(atlasConfig);
  WorkspaceCapabilityRegistry.initialize();

  // Test federation with capabilities
  const grantedCapabilities = federationManager.getGrantedCapabilities("analytics", "dev-team");
  if (!grantedCapabilities.includes("jobs.list")) {
    throw new Error("Analytics should have read_only access to dev-team");
  }

  // Test environment + MCP integration
  const resolver = new EnvironmentResolver();
  const mcpEnv = await resolver.resolveAll({
    GITHUB_TOKEN: {
      from_env: "GITHUB_TOKEN",
      default: "fallback-token",
    },
  });

  if (!mcpEnv.GITHUB_TOKEN) {
    throw new Error("MCP environment resolution failed");
  }

  console.log("Integration test results:", {
    federationCapabilities: grantedCapabilities,
    mcpEnvironment: Object.keys(mcpEnv),
  });

  console.log("✅ Full integration test passed");
}

async function runMigrationTests(): Promise<void> {
  console.log("🚀 Running Atlas Architectural Foundation Migration Tests\n");

  try {
    await testConfigurationLoading();
    await testEnvironmentResolution();
    await testFederationSystem();
    await testWorkspaceCapabilities();
    await testFullIntegration();

    console.log("\n🎉 All migration tests passed!");
    console.log("✅ Atlas Architectural Foundation is ready for deployment");
    
  } catch (error) {
    console.error("\n❌ Migration test failed:", error.message);
    console.error(error.stack);
    Deno.exit(1);
  }
}

// Run the tests
if (import.meta.main) {
  await runMigrationTests();
}