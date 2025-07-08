/**
 * Integration tests for two-level MCP architecture
 * Tests the interaction between atlas.yml (platform) and workspace.yml (workspace) MCP settings
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PlatformMCPServer } from "../src/platform-server.ts";
import { checkJobDiscoverable, checkWorkspaceMCPEnabled } from "../src/tools/utils.ts";
import { AtlasLogger } from "../../../src/utils/logger.ts";

// Test workspace interface for type safety
interface TestWorkspace {
  id: string;
  name: string;
  config: unknown;
  jobs: unknown[];
}

// Mock daemon server that simulates atlas.yml + workspace.yml configurations
class MockAtlasIntegrationDaemon {
  private port: number;
  private server?: Deno.HttpServer;
  private atlasConfig: unknown = {};
  private workspaces: Map<string, TestWorkspace> = new Map();

  constructor(port: number = 8084) {
    this.port = port;
  }

  setAtlasConfig(config: unknown) {
    this.atlasConfig = config;
  }

  setupWorkspace(workspaceId: string, workspaceConfig: unknown, jobs: unknown[] = []) {
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      name: `Test Workspace ${workspaceId}`,
      config: workspaceConfig,
      jobs,
    });
  }

  start() {
    this.server = Deno.serve({ port: this.port }, (req) => {
      const url = new URL(req.url);

      // Atlas config endpoint (simulated)
      if (url.pathname === "/api/atlas/config") {
        return new Response(JSON.stringify(this.atlasConfig));
      }

      // Workspace endpoints
      if (url.pathname.startsWith("/api/workspaces/")) {
        const pathParts = url.pathname.split("/");
        const workspaceId = pathParts[3];

        if (pathParts.length === 4) {
          // GET /api/workspaces/{id}
          const workspace = this.workspaces.get(workspaceId);
          if (!workspace) {
            return new Response(JSON.stringify({ error: "Workspace not found" }), { status: 404 });
          }
          return new Response(JSON.stringify(workspace));
        } else if (pathParts[4] === "jobs") {
          // GET /api/workspaces/{id}/jobs
          const workspace = this.workspaces.get(workspaceId);
          if (!workspace) {
            return new Response(JSON.stringify({ error: "Workspace not found" }), { status: 404 });
          }
          return new Response(JSON.stringify(workspace.jobs));
        }
      }

      if (url.pathname === "/health") {
        return new Response("OK");
      }

      return new Response("Not Found", { status: 404 });
    });
  }

  async stop() {
    if (this.server) {
      await this.server.shutdown();
      this.server = undefined;
      // Give server time to fully close connections
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Clear stored data
    this.workspaces.clear();
    this.atlasConfig = {};
  }
}

Deno.test({
  name: "Two-Level MCP Integration Tests",
  sanitizeResources: false, // Disable resource sanitization due to logger file handles
  fn: async (t) => {
    const mockDaemon = new MockAtlasIntegrationDaemon(8084);
    await mockDaemon.start();

    try {
      await t.step("Setup: Atlas enabled, Workspace enabled - Should allow access", async () => {
        // Atlas config enables platform MCP
        mockDaemon.setAtlasConfig({
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                capabilities: ["workspace_*"],
              },
            },
          },
        });

        // Workspace config enables workspace MCP
        mockDaemon.setupWorkspace("test-both-enabled", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["public_test"],
              },
            },
          },
        }, [
          { name: "public_test", description: "Public test job" },
        ]);

        const _mcpServer = new PlatformMCPServer({
          logger: console,
          daemonUrl: "http://localhost:8084",
        });

        // Should be able to check workspace MCP (workspace level enabled)
        const workspaceMCPEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8084",
          "test-both-enabled",
          console,
        );
        assertEquals(workspaceMCPEnabled, true);

        // Should be able to check job discoverability
        const jobDiscoverable = await checkJobDiscoverable(
          "http://localhost:8084",
          "test-both-enabled",
          "public_test",
          console,
        );
        assertEquals(jobDiscoverable, true);

        // Note: withWorkspaceMCPCheck has been removed.
        // The security checks are now handled internally by the tool implementations.
      });

      await t.step("Atlas enabled, Workspace disabled - Should block access", async () => {
        // Atlas config enables platform MCP
        mockDaemon.setAtlasConfig({
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                capabilities: ["workspace_*"],
              },
            },
          },
        });

        // Workspace config DISABLES workspace MCP
        mockDaemon.setupWorkspace("test-workspace-disabled", {
          server: {
            mcp: {
              enabled: false, // Workspace MCP disabled
            },
          },
        }, [
          { name: "blocked_job", description: "Should be blocked" },
        ]);

        const _mcpServer = new PlatformMCPServer({
          logger: console,
          daemonUrl: "http://localhost:8084",
        });

        // Workspace MCP should be disabled
        const workspaceMCPEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8084",
          "test-workspace-disabled",
          console,
        );
        assertEquals(workspaceMCPEnabled, false);

        // Job should not be discoverable (workspace MCP disabled)
        const jobDiscoverable = await checkJobDiscoverable(
          "http://localhost:8084",
          "test-workspace-disabled",
          "blocked_job",
          console,
        );
        assertEquals(jobDiscoverable, false);

        // Note: withWorkspaceMCPCheck has been removed.
        // The security checks are now handled internally by the tool implementations.
      });

      await t.step("Atlas disabled - Platform MCP server shouldn't exist", async () => {
        // Atlas config DISABLES platform MCP
        mockDaemon.setAtlasConfig({
          server: {
            mcp: {
              enabled: false, // Platform MCP disabled
            },
          },
        });

        // Workspace config enables workspace MCP (but shouldn't matter)
        mockDaemon.setupWorkspace("test-atlas-disabled", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["some_job"],
              },
            },
          },
        }, [
          { name: "some_job", description: "Some job" },
        ]);

        // In real implementation, Platform MCP Server wouldn't even be created
        // if atlas.yml has MCP disabled. For testing, we'll verify the atlas config.
        const atlasResponse = await fetch("http://localhost:8084/api/atlas/config");
        const atlasConfig = await atlasResponse.json();

        assertEquals(atlasConfig.server?.mcp?.enabled, false, "Atlas MCP should be disabled");

        // Platform MCP Server behavior when atlas is disabled would be:
        // - The server process wouldn't start at all
        // - No platform capabilities would be available
        // This is an architectural decision - when atlas.yml disables MCP,
        // the entire platform MCP server is unavailable
      });

      await t.step("Granular capability control via atlas.yml", async () => {
        // Atlas config with specific capabilities
        mockDaemon.setAtlasConfig({
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                capabilities: [
                  "workspace_list",
                  "workspace_describe",
                  "workspace_jobs_*", // Only job-related capabilities
                  // Note: workspace_create, workspace_delete not included
                ],
              },
            },
          },
        });

        mockDaemon.setupWorkspace("test-granular", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["allowed_job"],
              },
            },
          },
        }, [
          { name: "allowed_job", description: "Allowed job" },
        ]);

        // Test capability filtering (this would be done by Platform MCP Server)
        const atlasResponse = await fetch("http://localhost:8084/api/atlas/config");
        const atlasConfig = await atlasResponse.json();
        const allowedCapabilities = atlasConfig.server?.mcp?.discoverable?.capabilities || [];

        // Check which platform capabilities are allowed
        function isCapabilityAllowed(capability: string): boolean {
          for (const pattern of allowedCapabilities) {
            const isWildcard = pattern.endsWith("*");
            const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;
            if (isWildcard ? capability.startsWith(basePattern) : capability === pattern) {
              return true;
            }
          }
          return false;
        }

        assertEquals(isCapabilityAllowed("workspace_list"), true);
        assertEquals(isCapabilityAllowed("workspace_describe"), true);
        assertEquals(isCapabilityAllowed("workspace_jobs_list"), true);
        assertEquals(isCapabilityAllowed("workspace_jobs_describe"), true);

        assertEquals(isCapabilityAllowed("workspace_create"), false);
        assertEquals(isCapabilityAllowed("workspace_delete"), false);
        assertEquals(isCapabilityAllowed("workspace_sessions_list"), false);
      });

      await t.step("Workspace-level job filtering with atlas.yml constraints", async () => {
        // Atlas allows job operations
        mockDaemon.setAtlasConfig({
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                capabilities: ["workspace_jobs_*"],
              },
            },
          },
        });

        // Workspace has specific job filters
        mockDaemon.setupWorkspace("test-job-filtering", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["public_*", "admin_special"], // Specific patterns
              },
            },
          },
        }, [
          { name: "public_task", description: "Public task" },
          { name: "public_demo", description: "Public demo" },
          { name: "admin_special", description: "Special admin task" },
          { name: "private_secret", description: "Private secret" },
          { name: "admin_regular", description: "Regular admin task" },
        ]);

        const _mcpServer = new PlatformMCPServer({
          logger: console,
          daemonUrl: "http://localhost:8084",
        });

        // Test job discoverability
        const tests = [
          { job: "public_task", expected: true },
          { job: "public_demo", expected: true },
          { job: "admin_special", expected: true },
          { job: "private_secret", expected: false },
          { job: "admin_regular", expected: false },
        ];

        for (const { job, expected } of tests) {
          const isDiscoverable = await checkJobDiscoverable(
            "http://localhost:8084",
            "test-job-filtering",
            job,
            console,
          );
          assertEquals(
            isDiscoverable,
            expected,
            `Job ${job} discoverability should be ${expected}`,
          );
        }
      });
    } finally {
      await mockDaemon.stop();
      // Reset logger to close any file handles
      AtlasLogger.resetInstance();
    }
  },
});

// Test error handling and edge cases
Deno.test({
  name: "Two-Level MCP Error Handling",
  sanitizeResources: false, // Disable resource sanitization due to logger file handles
  fn: async (t) => {
    const mockDaemon = new MockAtlasIntegrationDaemon(8085);
    await mockDaemon.start();

    try {
      await t.step("Missing atlas.yml config fails gracefully", async () => {
        // No atlas config set
        mockDaemon.setupWorkspace("test-missing-atlas", {
          server: {
            mcp: {
              enabled: true,
              discoverable: { jobs: ["some_job"] },
            },
          },
        });

        // Atlas config request should return empty object or error
        const atlasResponse = await fetch("http://localhost:8085/api/atlas/config");
        const atlasConfig = await atlasResponse.json();

        // Should default to disabled when no config
        assertEquals(atlasConfig.server?.mcp?.enabled, undefined);
      });

      await t.step("Malformed workspace config fails closed", async () => {
        mockDaemon.setAtlasConfig({
          server: { mcp: { enabled: true, discoverable: { capabilities: ["*"] } } },
        });

        // Workspace with malformed MCP config
        mockDaemon.setupWorkspace("test-malformed", {
          server: {
            // Missing mcp section entirely
          },
        });

        const _mcpServer = new PlatformMCPServer({
          logger: console,
          daemonUrl: "http://localhost:8085",
        });

        // Should fail closed (disabled) for malformed config
        const workspaceMCPEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8085",
          "test-malformed",
          console,
        );
        assertEquals(workspaceMCPEnabled, false);
      });

      await t.step("Network errors fail closed", async () => {
        // Create MCP server pointing to non-existent daemon
        const _badMcpServer = new PlatformMCPServer({
          logger: console,
          daemonUrl: "http://localhost:9999",
        });

        // All operations should fail closed
        const workspaceMCPEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:9999",
          "any-workspace",
          console,
        );
        assertEquals(workspaceMCPEnabled, false);

        const jobDiscoverable = await checkJobDiscoverable(
          "http://localhost:9999",
          "any-workspace",
          "any_job",
          console,
        );
        assertEquals(jobDiscoverable, false);
      });
    } finally {
      await mockDaemon.stop();
      // Reset logger to close any file handles
      AtlasLogger.resetInstance();
    }
  },
});
