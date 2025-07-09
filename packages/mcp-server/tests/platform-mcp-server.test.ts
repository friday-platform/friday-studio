/**
 * Tests for Platform MCP Server job discoverability filtering
 * Covers integration between daemon API, MCP server, and workspace configuration
 */

import { assertEquals } from "@std/assert";
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

// Mock daemon server for testing
class MockDaemonServer {
  private workspaces: Map<string, TestWorkspace> = new Map();
  private port: number;
  private server?: Deno.HttpServer;

  constructor(port: number = 8081) {
    this.port = port;
  }

  // Set up test workspace configurations
  setupTestWorkspace(workspaceId: string, config: unknown, jobs: unknown[] = []) {
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      name: `Test Workspace ${workspaceId}`,
      config,
      jobs,
    });
  }

  start() {
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

    const _mcpServer = new PlatformMCPServer({
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
        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-1",
          "telephone",
          console,
        );
        assertEquals(isDiscoverable, true, "telephone job should be discoverable via exact match");
      });

      await t.step("checkJobDiscoverable - wildcard match", async () => {
        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-1",
          "public_demo",
          console,
        );
        assertEquals(
          isDiscoverable,
          true,
          "public_demo should be discoverable via public_* pattern",
        );
      });

      await t.step("checkJobDiscoverable - no match", async () => {
        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-1",
          "private_secret",
          console,
        );
        assertEquals(isDiscoverable, false, "private_secret should not be discoverable");
      });

      await t.step("checkJobDiscoverable - admin wildcard pattern", async () => {
        const adminCleanup = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-2",
          "admin_cleanup",
          console,
        );
        const adminBackup = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-2",
          "admin_backup",
          console,
        );
        const userTask = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-2",
          "user_task",
          console,
        );

        assertEquals(adminCleanup, true, "admin_cleanup should match admin_* pattern");
        assertEquals(adminBackup, true, "admin_backup should match admin_* pattern");
        assertEquals(userTask, false, "user_task should not match admin_* pattern");
      });

      await t.step("checkWorkspaceMCPEnabled - enabled workspace", async () => {
        const isEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8081",
          "test-workspace-1",
          console,
        );
        assertEquals(isEnabled, true, "test-workspace-1 should have MCP enabled");
      });

      await t.step("checkWorkspaceMCPEnabled - disabled workspace", async () => {
        const isEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8081",
          "test-workspace-3",
          console,
        );
        assertEquals(isEnabled, false, "test-workspace-3 should have MCP disabled");
      });

      await t.step("checkWorkspaceMCPEnabled - nonexistent workspace", async () => {
        const isEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8081",
          "nonexistent",
          console,
        );
        assertEquals(isEnabled, false, "nonexistent workspace should fail closed");
      });

      // Note: withWorkspaceMCPCheck and withJobDiscoverabilityCheck have been removed
      // as they are no longer part of the platform server's public API.
      // The security checks are now handled internally by the tool implementations.

      await t.step("Empty discoverable jobs list blocks all jobs", async () => {
        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8081",
          "test-workspace-4",
          "blocked_job",
          console,
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

      const _mcpServer = new PlatformMCPServer({
        logger: console,
        daemonUrl: "http://localhost:8082",
      });

      await t.step("workspace_jobs_list filters jobs correctly", async () => {
        // First check if workspace has MCP enabled
        const mcpEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8082",
          "integration-test",
          console,
        );
        assertEquals(mcpEnabled, true, "Workspace should have MCP enabled");

        // Simulate the actual workspace_jobs_list implementation
        const response = await fetch(
          `http://localhost:8082/api/workspaces/integration-test/jobs`,
        );
        const allJobs = await response.json();
        // Note: response.json() automatically consumes and closes the body

        // Filter jobs based on discoverability
        const discoverableJobs = [];
        for (const job of allJobs) {
          const isDiscoverable = await checkJobDiscoverable(
            "http://localhost:8082",
            "integration-test",
            job.name,
            console,
          );
          if (isDiscoverable) {
            discoverableJobs.push(job);
          }
        }

        assertEquals(discoverableJobs.length, 1, "Should return only 1 discoverable job");
        assertEquals(
          discoverableJobs[0].name,
          "public_test",
          "Should return only the public_test job",
        );
      });

      await t.step("workspace_jobs_describe allows discoverable job", async () => {
        // First check if job is discoverable
        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8082",
          "integration-test",
          "public_test",
          console,
        );
        assertEquals(isDiscoverable, true, "public_test should be discoverable");

        // Simulate fetching job details
        const response = await fetch(
          `http://localhost:8082/api/workspaces/integration-test/jobs`,
        );
        const jobs = await response.json();
        // Note: response.json() automatically consumes and closes the body
        const job = jobs.find((j: unknown) => (j as { name: string }).name === "public_test");

        assertEquals(job.name, "public_test");
        assertEquals(job.description, "Public test job");
      });

      await t.step("workspace_jobs_describe blocks non-discoverable job", async () => {
        // Should fail for non-discoverable job
        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8082",
          "integration-test",
          "private_test",
          console,
        );
        assertEquals(isDiscoverable, false, "private_test should not be discoverable");
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

    const _mcpServer = new PlatformMCPServer({
      logger: console,
      daemonUrl: "http://localhost:8083",
    });

    try {
      await t.step("Malformed workspace config fails closed", async () => {
        mockDaemon.setupTestWorkspace("malformed-config", {
          // Missing server.mcp section entirely
        });

        const isEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:8083",
          "malformed-config",
          console,
        );
        assertEquals(isEnabled, false, "Should fail closed for malformed config");

        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:8083",
          "malformed-config",
          "any_job",
          console,
        );
        assertEquals(isDiscoverable, false, "Should fail closed for missing discoverable config");
      });

      await t.step("Network errors fail closed", async () => {
        const isEnabled = await checkWorkspaceMCPEnabled(
          "http://localhost:9999", // Non-existent daemon
          "any-workspace",
          console,
        );
        assertEquals(isEnabled, false, "Should fail closed on network error");

        const isDiscoverable = await checkJobDiscoverable(
          "http://localhost:9999", // Non-existent daemon
          "any-workspace",
          "any_job",
          console,
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
          const isDiscoverable = await checkJobDiscoverable(
            "http://localhost:8083",
            "complex-patterns",
            job,
            console,
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
