/**
 * Tests for Platform MCP Server job discoverability filtering
 * Covers integration between daemon API, MCP server, and workspace configuration
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PlatformMCPServer } from "../src/platform-server.ts";
import { AtlasLogger } from "../../../src/utils/logger.ts";

// Mock daemon server for testing
class MockDaemonServer {
  private workspaces: Map<string, any> = new Map();
  private port: number;
  private server?: Deno.HttpServer;

  constructor(port: number = 8081) {
    this.port = port;
  }

  // Set up test workspace configurations
  setupTestWorkspace(workspaceId: string, config: any, jobs: any[] = []) {
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      name: `Test Workspace ${workspaceId}`,
      config,
      jobs,
    });
  }

  async start() {
    this.server = Deno.serve({ port: this.port }, (req) => {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/api/workspaces/")) {
        const pathParts = url.pathname.split("/");
        const workspaceId = pathParts[3];

        if (pathParts.length === 4) {
          // GET /api/workspaces/{id} - workspace details with config
          const workspace = this.workspaces.get(workspaceId);
          if (!workspace) {
            return new Response(JSON.stringify({ error: "Workspace not found" }), { status: 404 });
          }
          return new Response(JSON.stringify(workspace));
        } else if (pathParts[4] === "jobs") {
          // GET /api/workspaces/{id}/jobs - list jobs
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
    // Clear any stored workspace data
    this.workspaces.clear();
  }
}

// Test suite
Deno.test({
  name: "Platform MCP Server - Job Discoverability Filtering",
  sanitizeResources: false, // Disable resource sanitization due to logger file handles
  fn: async (t) => {
    const mockDaemon = new MockDaemonServer(8081);
    await mockDaemon.start();

    const mcpServer = new PlatformMCPServer({
      logger: console,
      daemonUrl: "http://localhost:8081",
    });

    try {
      await t.step("Setup test workspaces", () => {
        // Workspace 1: MCP enabled, specific jobs discoverable
        mockDaemon.setupTestWorkspace("test-workspace-1", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["telephone", "public_*"],
              },
            },
          },
        }, [
          { name: "telephone", description: "Telephone game job" },
          { name: "public_demo", description: "Public demo job" },
          { name: "private_secret", description: "Private secret job" },
        ]);

        // Workspace 2: MCP enabled, only wildcard pattern
        mockDaemon.setupTestWorkspace("test-workspace-2", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["admin_*"],
              },
            },
          },
        }, [
          { name: "admin_cleanup", description: "Admin cleanup job" },
          { name: "user_task", description: "User task job" },
          { name: "admin_backup", description: "Admin backup job" },
        ]);

        // Workspace 3: MCP disabled
        mockDaemon.setupTestWorkspace("test-workspace-3", {
          server: {
            mcp: {
              enabled: false,
            },
          },
        }, [
          { name: "any_job", description: "Any job" },
        ]);

        // Workspace 4: No discoverable jobs configured
        mockDaemon.setupTestWorkspace("test-workspace-4", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: [],
              },
            },
          },
        }, [
          { name: "blocked_job", description: "Should be blocked" },
        ]);
      });

      await t.step("checkJobDiscoverable - exact match", async () => {
        const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-1",
          "telephone",
        );
        assertEquals(isDiscoverable, true, "telephone job should be discoverable via exact match");
      });

      await t.step("checkJobDiscoverable - wildcard match", async () => {
        const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-1",
          "public_demo",
        );
        assertEquals(
          isDiscoverable,
          true,
          "public_demo should be discoverable via public_* pattern",
        );
      });

      await t.step("checkJobDiscoverable - no match", async () => {
        const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-1",
          "private_secret",
        );
        assertEquals(isDiscoverable, false, "private_secret should not be discoverable");
      });

      await t.step("checkJobDiscoverable - admin wildcard pattern", async () => {
        const adminCleanup = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-2",
          "admin_cleanup",
        );
        const adminBackup = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-2",
          "admin_backup",
        );
        const userTask = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-2",
          "user_task",
        );

        assertEquals(adminCleanup, true, "admin_cleanup should match admin_* pattern");
        assertEquals(adminBackup, true, "admin_backup should match admin_* pattern");
        assertEquals(userTask, false, "user_task should not match admin_* pattern");
      });

      await t.step("checkWorkspaceMCPEnabled - enabled workspace", async () => {
        const isEnabled = await (mcpServer as any).checkWorkspaceMCPEnabled("test-workspace-1");
        assertEquals(isEnabled, true, "test-workspace-1 should have MCP enabled");
      });

      await t.step("checkWorkspaceMCPEnabled - disabled workspace", async () => {
        const isEnabled = await (mcpServer as any).checkWorkspaceMCPEnabled("test-workspace-3");
        assertEquals(isEnabled, false, "test-workspace-3 should have MCP disabled");
      });

      await t.step("checkWorkspaceMCPEnabled - nonexistent workspace", async () => {
        const isEnabled = await (mcpServer as any).checkWorkspaceMCPEnabled("nonexistent");
        assertEquals(isEnabled, false, "nonexistent workspace should fail closed");
      });

      await t.step("withWorkspaceMCPCheck - enabled workspace", async () => {
        const result = await (mcpServer as any).withWorkspaceMCPCheck(
          { workspaceId: "test-workspace-1" },
          async ({ workspaceId }) => ({ success: true, workspaceId }),
        );
        assertEquals(result.success, true);
        assertEquals(result.workspaceId, "test-workspace-1");
      });

      await t.step("withWorkspaceMCPCheck - disabled workspace", async () => {
        await assertRejects(
          async () => {
            await (mcpServer as any).withWorkspaceMCPCheck(
              { workspaceId: "test-workspace-3" },
              async () => ({ success: true }),
            );
          },
          Error,
          "MCP is disabled for workspace",
        );
      });

      await t.step("withJobDiscoverabilityCheck - discoverable job", async () => {
        const result = await (mcpServer as any).withJobDiscoverabilityCheck(
          { workspaceId: "test-workspace-1", jobName: "telephone" },
          async ({ workspaceId, jobName }) => ({ success: true, workspaceId, jobName }),
        );
        assertEquals(result.success, true);
        assertEquals(result.jobName, "telephone");
      });

      await t.step("withJobDiscoverabilityCheck - non-discoverable job", async () => {
        await assertRejects(
          async () => {
            await (mcpServer as any).withJobDiscoverabilityCheck(
              { workspaceId: "test-workspace-1", jobName: "private_secret" },
              async () => ({ success: true }),
            );
          },
          Error,
          "not discoverable",
        );
      });

      await t.step("withJobDiscoverabilityCheck - MCP disabled workspace", async () => {
        await assertRejects(
          async () => {
            await (mcpServer as any).withJobDiscoverabilityCheck(
              { workspaceId: "test-workspace-3", jobName: "any_job" },
              async () => ({ success: true }),
            );
          },
          Error,
          "MCP is disabled",
        );
      });

      await t.step("Empty discoverable jobs list blocks all jobs", async () => {
        const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
          "test-workspace-4",
          "blocked_job",
        );
        assertEquals(
          isDiscoverable,
          false,
          "jobs should be blocked when discoverable list is empty",
        );
      });
    } finally {
      // Ensure proper cleanup
      await mockDaemon.stop();
      // Reset logger to close any file handles
      AtlasLogger.resetInstance();
    }
  },
});

// Integration test with actual MCP tool calls
Deno.test({
  name: "Platform MCP Server - Integration Test with Tool Calls",
  sanitizeResources: false, // Disable resource sanitization due to logger file handles
  fn: async (t) => {
    const mockDaemon = new MockDaemonServer(8082);
    await mockDaemon.start();

    try {
      // Setup test workspace
      mockDaemon.setupTestWorkspace("integration-test", {
        server: {
          mcp: {
            enabled: true,
            discoverable: {
              jobs: ["public_*"],
            },
          },
        },
      }, [
        { name: "public_test", description: "Public test job" },
        { name: "private_test", description: "Private test job" },
        { name: "telephone", description: "Telephone job" },
      ]);

      const mcpServer = new PlatformMCPServer({
        logger: console,
        daemonUrl: "http://localhost:8082",
      });

      await t.step("workspace_jobs_list filters jobs correctly", async () => {
        // Simulate the MCP tool call for workspace_jobs_list
        const result = await (mcpServer as any).withWorkspaceMCPCheck(
          { workspaceId: "integration-test" },
          async ({ workspaceId }) => {
            // This simulates the actual workspace_jobs_list implementation
            const response = await fetch(
              `http://localhost:8082/api/workspaces/${workspaceId}/jobs`,
            );
            const allJobs = await response.json();
            // Note: response.json() automatically consumes and closes the body

            // Filter jobs based on discoverability
            const discoverableJobs = [];
            for (const job of allJobs) {
              const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
                workspaceId,
                job.name,
              );
              if (isDiscoverable) {
                discoverableJobs.push(job);
              }
            }

            return {
              jobs: discoverableJobs,
              total: discoverableJobs.length,
              filtered: true,
            };
          },
        );

        assertEquals(result.total, 1, "Should return only 1 discoverable job");
        assertEquals(result.jobs[0].name, "public_test", "Should return only the public_test job");
        assertEquals(result.filtered, true, "Should indicate filtering was applied");
      });

      await t.step("workspace_jobs_describe allows discoverable job", async () => {
        // Should succeed for discoverable job
        const result = await (mcpServer as any).withJobDiscoverabilityCheck(
          { workspaceId: "integration-test", jobName: "public_test" },
          async ({ workspaceId, jobName }) => {
            const response = await fetch(
              `http://localhost:8082/api/workspaces/${workspaceId}/jobs`,
            );
            const jobs = await response.json();
            // Note: response.json() automatically consumes and closes the body
            const job = jobs.find((j: any) => j.name === jobName);
            return { job };
          },
        );

        assertEquals(result.job.name, "public_test");
        assertEquals(result.job.description, "Public test job");
      });

      await t.step("workspace_jobs_describe blocks non-discoverable job", async () => {
        // Should fail for non-discoverable job
        await assertRejects(
          async () => {
            await (mcpServer as any).withJobDiscoverabilityCheck(
              { workspaceId: "integration-test", jobName: "private_test" },
              async () => ({ success: true }),
            );
          },
          Error,
          "not discoverable",
        );
      });
    } finally {
      // Ensure proper cleanup
      await mockDaemon.stop();
      // Reset logger to close any file handles
      AtlasLogger.resetInstance();
    }
  },
});

// Edge cases and error handling
Deno.test({
  name: "Platform MCP Server - Edge Cases",
  sanitizeResources: false, // Disable resource sanitization due to logger file handles
  fn: async (t) => {
    const mockDaemon = new MockDaemonServer(8083);
    await mockDaemon.start();

    const mcpServer = new PlatformMCPServer({
      logger: console,
      daemonUrl: "http://localhost:8083",
    });

    try {
      await t.step("Malformed workspace config fails closed", async () => {
        mockDaemon.setupTestWorkspace("malformed-config", {
          // Missing server.mcp section entirely
        });

        const isEnabled = await (mcpServer as any).checkWorkspaceMCPEnabled("malformed-config");
        assertEquals(isEnabled, false, "Should fail closed for malformed config");

        const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
          "malformed-config",
          "any_job",
        );
        assertEquals(isDiscoverable, false, "Should fail closed for missing discoverable config");
      });

      await t.step("Network errors fail closed", async () => {
        const badMcpServer = new PlatformMCPServer({
          logger: console,
          daemonUrl: "http://localhost:9999", // Non-existent daemon
        });

        const isEnabled = await (badMcpServer as any).checkWorkspaceMCPEnabled("any-workspace");
        assertEquals(isEnabled, false, "Should fail closed on network error");

        const isDiscoverable = await (badMcpServer as any).checkJobDiscoverable(
          "any-workspace",
          "any_job",
        );
        assertEquals(isDiscoverable, false, "Should fail closed on network error");
      });

      await t.step("Complex wildcard patterns work correctly", async () => {
        mockDaemon.setupTestWorkspace("complex-patterns", {
          server: {
            mcp: {
              enabled: true,
              discoverable: {
                jobs: ["admin_*", "public_*", "exact_match"],
              },
            },
          },
        });

        const tests = [
          { job: "admin_task", expected: true },
          { job: "admin_", expected: true }, // Edge case: just the prefix
          { job: "public_demo", expected: true },
          { job: "exact_match", expected: true },
          { job: "exact_match_not", expected: false },
          { job: "test_something_special", expected: false }, // Our implementation doesn't support middle wildcards
          { job: "test_special", expected: false },
          { job: "random_job", expected: false },
        ];

        for (const { job, expected } of tests) {
          const isDiscoverable = await (mcpServer as any).checkJobDiscoverable(
            "complex-patterns",
            job,
          );
          assertEquals(
            isDiscoverable,
            expected,
            `Job "${job}" discoverability should be ${expected}`,
          );
        }
      });
    } finally {
      // Ensure proper cleanup
      await mockDaemon.stop();
      // Reset logger to close any file handles
      AtlasLogger.resetInstance();
    }
  },
});
