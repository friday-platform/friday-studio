/**
 * Unit tests for job tools
 * Tests job-related operations with mocked daemon API calls
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { createSuccessResponse } from "../../src/tools/types.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Mock fetch helpers
async function mockFetchWithTimeout(url: string, options?: RequestInit) {
  return fetch(url, options);
}

async function mockHandleDaemonResponse(response: Response, operation: string, logger: any) {
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
    );
  }
  return response.json();
}

// Extract job discoverability logic from src/tools/utils.ts
async function checkJobDiscoverable(
  daemonUrl: string,
  workspaceId: string,
  jobName: string,
  logger: any,
): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}`);
    if (!response.ok) {
      // Consume the response body to prevent leaks
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
      return false; // Fail closed
    }

    const workspace = await response.json();
    const discoverableJobs = workspace.config?.server?.mcp?.discoverable?.jobs || [];

    // Check if job matches any discoverable pattern
    for (const pattern of discoverableJobs) {
      const isWildcard = pattern.endsWith("*");
      const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

      if (isWildcard ? jobName.startsWith(basePattern) : jobName === pattern) {
        logger.debug("Platform MCP: Job is discoverable", {
          workspaceId,
          jobName,
          pattern,
        });
        return true;
      }
    }

    logger.debug("Platform MCP: Job not discoverable", {
      workspaceId,
      jobName,
      discoverableJobs,
    });

    return false;
  } catch (error) {
    // Consume any remaining response body to prevent leaks
    if (response) {
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
    }
    logger.error("Platform MCP: Error checking job discoverability", {
      workspaceId,
      jobName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false; // Fail closed
  }
}

// Check if workspace has MCP enabled
async function checkWorkspaceMCPEnabled(
  daemonUrl: string,
  workspaceId: string,
  logger: any,
): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}`);
    if (!response.ok) {
      // Consume the response body to prevent leaks
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
      logger.warn("Platform MCP: Failed to check workspace MCP settings", {
        workspaceId,
        status: response.status,
      });
      return false; // Fail closed - deny access if can't verify
    }

    const workspace = await response.json();
    const mcpEnabled = workspace.config?.server?.mcp?.enabled ?? false;

    logger.debug("Platform MCP: Checked workspace MCP settings", {
      workspaceId,
      mcpEnabled,
    });

    return mcpEnabled;
  } catch (error) {
    // Consume any remaining response body to prevent leaks
    if (response) {
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
    }
    logger.error("Platform MCP: Error checking workspace MCP settings", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false; // Fail closed - deny access on error
  }
}

// Extract core logic from job list tool for testing
async function jobListToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  workspaceId: string;
}) {
  ctx.logger.info("MCP workspace_jobs_list called", { workspaceId: params.workspaceId });

  try {
    // Check if workspace has MCP enabled
    const mcpEnabled = await checkWorkspaceMCPEnabled(
      ctx.daemonUrl,
      params.workspaceId,
      ctx.logger,
    );
    if (!mcpEnabled) {
      throw new Error("MCP is not enabled for this workspace");
    }

    // Fetch jobs from workspace
    const response = await mockFetchWithTimeout(
      `${ctx.daemonUrl}/api/workspaces/${params.workspaceId}/jobs`,
    );
    const result = await mockHandleDaemonResponse(response, "workspace_jobs_list", ctx.logger);

    // Filter jobs based on discoverability
    const jobs = result.jobs || [];
    const discoverableJobs = [];

    for (const job of jobs) {
      const isDiscoverable = await checkJobDiscoverable(
        ctx.daemonUrl,
        params.workspaceId,
        job.name,
        ctx.logger,
      );
      if (isDiscoverable) {
        discoverableJobs.push(job);
      }
    }

    ctx.logger.info("MCP workspace_jobs_list response", {
      workspaceId: params.workspaceId,
      totalJobs: jobs.length,
      discoverableJobs: discoverableJobs.length,
    });

    return createSuccessResponse({
      jobs: discoverableJobs,
      totalJobs: jobs.length,
      discoverableJobs: discoverableJobs.length,
      filtered: jobs.length - discoverableJobs.length,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_jobs_list failed", { workspaceId: params.workspaceId, error });
    throw error;
  }
}

// Extract core logic from job describe tool for testing
async function jobDescribeToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  workspaceId: string;
  jobName: string;
}) {
  ctx.logger.info("MCP workspace_jobs_describe called", {
    workspaceId: params.workspaceId,
    jobName: params.jobName,
  });

  try {
    // Check if workspace has MCP enabled
    const mcpEnabled = await checkWorkspaceMCPEnabled(
      ctx.daemonUrl,
      params.workspaceId,
      ctx.logger,
    );
    if (!mcpEnabled) {
      throw new Error("MCP is not enabled for this workspace");
    }

    // Check if job is discoverable
    const isDiscoverable = await checkJobDiscoverable(
      ctx.daemonUrl,
      params.workspaceId,
      params.jobName,
      ctx.logger,
    );
    if (!isDiscoverable) {
      throw new Error(
        `Job '${params.jobName}' is not discoverable in workspace '${params.workspaceId}'`,
      );
    }

    // Fetch jobs from workspace
    const response = await mockFetchWithTimeout(
      `${ctx.daemonUrl}/api/workspaces/${params.workspaceId}/jobs`,
    );
    const result = await mockHandleDaemonResponse(response, "workspace_jobs_describe", ctx.logger);

    // Find specific job
    const jobs = result.jobs || [];
    const job = jobs.find((j: any) => j.name === params.jobName);

    if (!job) {
      throw new Error(`Job '${params.jobName}' not found in workspace '${params.workspaceId}'`);
    }

    ctx.logger.info("MCP workspace_jobs_describe response", {
      workspaceId: params.workspaceId,
      jobName: params.jobName,
      jobType: job.type,
    });

    return createSuccessResponse({
      ...job,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_jobs_describe failed", {
      workspaceId: params.workspaceId,
      jobName: params.jobName,
      error,
    });
    throw error;
  }
}

// Mock data for jobs
const mockJobs = [
  {
    name: "test-job-1",
    description: "Test job 1",
    type: "scheduled",
    schedule: "0 0 * * *",
    enabled: true,
    lastRun: "2023-01-01T00:00:00Z",
    nextRun: "2023-01-02T00:00:00Z",
    status: "running",
  },
  {
    name: "test-job-2",
    description: "Test job 2",
    type: "manual",
    enabled: true,
    lastRun: null,
    nextRun: null,
    status: "idle",
  },
  {
    name: "hidden-job",
    description: "Hidden job",
    type: "scheduled",
    schedule: "0 1 * * *",
    enabled: false,
    lastRun: null,
    nextRun: null,
    status: "disabled",
  },
];

const mockWorkspaceConfig = {
  id: "workspace-1",
  name: "Test Workspace",
  config: {
    server: {
      mcp: {
        enabled: true,
        discoverable: {
          jobs: ["test-job-1", "test-job-*"],
        },
      },
    },
  },
};

const mockWorkspaceConfigNoMCP = {
  id: "workspace-1",
  name: "Test Workspace",
  config: {
    server: {},
  },
};

// Mock fetch function for testing
function createMockFetch(mockResponses: Record<string, any>) {
  return async (url: string, options?: any) => {
    // Try exact match first
    let response = mockResponses[url];

    // If no exact match, try to find a matching pattern
    if (!response) {
      for (const [pattern, mockResponse] of Object.entries(mockResponses)) {
        // Check if the URL starts with the pattern (for query parameters)
        if (url.startsWith(pattern)) {
          response = mockResponse;
          break;
        }

        // Check if the pattern matches the base URL (ignoring query params)
        const urlBase = url.split("?")[0];
        const patternBase = pattern.split("?")[0];
        if (urlBase === patternBase) {
          response = mockResponse;
          break;
        }
      }
    }

    if (!response) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({ error: "Not found" }),
        text: async () => "Not found",
      };
    }

    return {
      ok: response.ok !== false,
      status: response.status || 200,
      statusText: response.statusText || "OK",
      json: async () => response.data,
      text: async () => JSON.stringify(response.data),
    };
  };
}

Deno.test("job list tool - lists jobs successfully", async () => {
  // Mock fetch to return workspace config and job list
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
    "http://mock-daemon/api/workspaces/workspace-1/jobs": {
      data: { jobs: mockJobs },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await jobListToolLogic(ctx, { workspaceId: "workspace-1" });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.jobs);
    assertEquals(response.totalJobs, 3);
    assertEquals(response.discoverableJobs, 2); // test-job-1 and test-job-2 (matches test-job-*)
    assertEquals(response.filtered, 1); // hidden-job is filtered out
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);

    // Check that only discoverable jobs are returned
    assertEquals(response.jobs.length, 2);
    assertEquals(response.jobs[0].name, "test-job-1");
    assertEquals(response.jobs[1].name, "test-job-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job list tool - handles MCP not enabled", async () => {
  // Mock fetch to return workspace without MCP enabled
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfigNoMCP,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await jobListToolLogic(ctx, { workspaceId: "workspace-1" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("MCP is not enabled"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job list tool - handles empty job list", async () => {
  // Mock fetch to return empty job array
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
    "http://mock-daemon/api/workspaces/workspace-1/jobs": {
      data: { jobs: [] },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await jobListToolLogic(ctx, { workspaceId: "workspace-1" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that empty list is handled correctly
    assertEquals(response.jobs, []);
    assertEquals(response.totalJobs, 0);
    assertEquals(response.discoverableJobs, 0);
    assertEquals(response.filtered, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job list tool - handles workspace not found", async () => {
  // Mock fetch to return 404 for workspace
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/nonexistent": {
      ok: false,
      status: 404,
      statusText: "Not Found",
      data: { error: "Workspace not found" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await jobListToolLogic(ctx, { workspaceId: "nonexistent" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("MCP is not enabled"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job describe tool - describes job successfully", async () => {
  // Mock fetch to return workspace config and job list
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
    "http://mock-daemon/api/workspaces/workspace-1/jobs": {
      data: { jobs: mockJobs },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await jobDescribeToolLogic(ctx, {
      workspaceId: "workspace-1",
      jobName: "test-job-1",
    });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.name, "test-job-1");
    assertEquals(response.description, "Test job 1");
    assertEquals(response.type, "scheduled");
    assertEquals(response.schedule, "0 0 * * *");
    assertEquals(response.enabled, true);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job describe tool - handles non-discoverable job", async () => {
  // Mock fetch to return workspace config and job list
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
    "http://mock-daemon/api/workspaces/workspace-1/jobs": {
      data: { jobs: mockJobs },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error for non-discoverable job
    let errorThrown = false;
    try {
      await jobDescribeToolLogic(ctx, {
        workspaceId: "workspace-1",
        jobName: "hidden-job",
      });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("is not discoverable"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job describe tool - handles job not found", async () => {
  // Mock fetch to return workspace config and job list
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
    "http://mock-daemon/api/workspaces/workspace-1/jobs": {
      data: { jobs: mockJobs },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error for non-existent job
    let errorThrown = false;
    try {
      await jobDescribeToolLogic(ctx, {
        workspaceId: "workspace-1",
        jobName: "nonexistent-job",
      });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("is not discoverable"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job describe tool - handles MCP not enabled", async () => {
  // Mock fetch to return workspace without MCP enabled
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfigNoMCP,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await jobDescribeToolLogic(ctx, {
        workspaceId: "workspace-1",
        jobName: "test-job-1",
      });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("MCP is not enabled"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("checkJobDiscoverable - allows discoverable job with exact match", async () => {
  // Mock fetch to return workspace config
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
  }) as typeof fetch;

  try {
    const result = await checkJobDiscoverable(
      "http://mock-daemon",
      "workspace-1",
      "test-job-1",
      mockLogger,
    );

    assertEquals(result, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("checkJobDiscoverable - allows discoverable job with wildcard match", async () => {
  // Mock fetch to return workspace config
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
  }) as typeof fetch;

  try {
    const result = await checkJobDiscoverable(
      "http://mock-daemon",
      "workspace-1",
      "test-job-2",
      mockLogger,
    );

    assertEquals(result, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("checkJobDiscoverable - blocks non-discoverable job", async () => {
  // Mock fetch to return workspace config
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfig,
    },
  }) as typeof fetch;

  try {
    const result = await checkJobDiscoverable(
      "http://mock-daemon",
      "workspace-1",
      "hidden-job",
      mockLogger,
    );

    assertEquals(result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("checkJobDiscoverable - handles missing MCP config", async () => {
  // Mock fetch to return workspace without MCP config
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      data: mockWorkspaceConfigNoMCP,
    },
  }) as typeof fetch;

  try {
    const result = await checkJobDiscoverable(
      "http://mock-daemon",
      "workspace-1",
      "test-job-1",
      mockLogger,
    );

    assertEquals(result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("checkJobDiscoverable - handles workspace not found", async () => {
  // Mock fetch to return 404 for workspace
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/nonexistent": {
      ok: false,
      status: 404,
      statusText: "Not Found",
      data: { error: "Workspace not found" },
    },
  }) as typeof fetch;

  try {
    const result = await checkJobDiscoverable(
      "http://mock-daemon",
      "nonexistent",
      "test-job-1",
      mockLogger,
    );

    assertEquals(result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job tools - handle network errors", async () => {
  // Mock fetch to throw network error
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network connection failed");
  };

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await jobListToolLogic(ctx, { workspaceId: "workspace-1" });
    } catch (error) {
      errorThrown = true;
      // The error may be "MCP is not enabled" because the network error occurs during MCP check
      assert(
        error.message.includes("Network connection failed") ||
          error.message.includes("MCP is not enabled"),
      );
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("job tools - handle server errors", async () => {
  // Mock fetch to return 500 errors
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/workspace-1": {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      data: { error: "Server error occurred" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await jobListToolLogic(ctx, { workspaceId: "workspace-1" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("MCP is not enabled"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
