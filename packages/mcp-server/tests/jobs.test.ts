import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Jobs Tools - list", async () => {
  const { client, transport } = await createMCPClient();
  let createdWorkspaceId: string | undefined;

  try {
    // Create a test workspace
    const testWorkspaceName = `test-jobs-workspace-${Date.now()}`;
    const testPath = await Deno.makeTempDir({
      prefix: "atlas_jobs_test_",
    });

    try {
      // Create workspace configuration with MCP enabled
      const workspaceConfig = {
        version: "1.0",
        workspace: {
          id: testWorkspaceName,
          name: testWorkspaceName,
        },
        server: {
          mcp: {
            enabled: true,
            discoverable: {
              jobs: ["*"],
            },
          },
        },
      };

      await Deno.writeTextFile(
        `${testPath}/workspace.yml`,
        `version: "1.0"
workspace:
  id: ${testWorkspaceName}
  name: ${testWorkspaceName}
server:
  mcp:
    enabled: true
    discoverable:
      jobs: ["*"]
`,
      );

      const createResult = await client.callTool({
        name: "atlas_workspace_create",
        arguments: {
          name: testWorkspaceName,
          path: testPath,
          description: "Test workspace for jobs tests",
        },
      });

      const createContent = createResult.content as Array<{ type: string; text: string }>;
      const createTextContent = createContent.find((item) => item.type === "text");
      const createData = JSON.parse(createTextContent!.text);

      createdWorkspaceId = createData.workspace.id;

      const result = await client.callTool({
        name: "atlas_workspace_jobs_list",
        arguments: {
          workspaceId: createdWorkspaceId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      console.log("Raw jobs list response:", textContent!.text);
      const responseData = JSON.parse(textContent!.text);

      // Should have jobs array
      assertExists(responseData.jobs);
      assertEquals(Array.isArray(responseData.jobs), true);

      // Should have workspace info
      assertExists(responseData.workspace);
      assertEquals(responseData.workspace.id, createdWorkspaceId);
    } finally {
      await Deno.remove(testPath, { recursive: true });
    }
  } finally {
    // Clean up created workspace
    if (createdWorkspaceId) {
      try {
        await client.callTool({
          name: "atlas_workspace_delete",
          arguments: {
            workspaceId: createdWorkspaceId,
            force: true,
          },
        });
      } catch (error) {
        console.warn(`Failed to clean up workspace ${createdWorkspaceId}:`, error);
      }
    }
    await transport.close();
  }
});

Deno.test("Jobs Tools - describe", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First get a workspace and job
    const workspaceResult = await client.callTool({
      name: "atlas_workspace_list",
      arguments: {},
    });

    const workspaceContent = workspaceResult.content as Array<{ type: string; text: string }>;
    const workspaceTextContent = workspaceContent.find((item) => item.type === "text");
    const workspaceData = JSON.parse(workspaceTextContent!.text);

    if (workspaceData.workspaces.length > 0) {
      const workspaceId = workspaceData.workspaces[0].id;

      const jobsResult = await client.callTool({
        name: "atlas_workspace_jobs_list",
        arguments: { workspaceId: workspaceId },
      });

      const jobsContent = jobsResult.content as Array<{ type: string; text: string }>;
      const jobsTextContent = jobsContent.find((item) => item.type === "text");
      const jobsData = JSON.parse(jobsTextContent!.text);

      if (jobsData.jobs.length > 0) {
        const jobName = jobsData.jobs[0].name;

        const result = await client.callTool({
          name: "atlas_workspace_jobs_describe",
          arguments: {
            workspaceId: workspaceId,
            jobName: jobName,
          },
        });

        assertEquals(Array.isArray(result.content), true);

        const content = result.content as Array<{ type: string; text: string }>;
        const textContent = content.find((item) => item.type === "text");
        const responseData = JSON.parse(textContent!.text);

        // Should have job details
        assertExists(responseData.job);
        assertEquals(responseData.job.name, jobName);
        assertExists(responseData.job.description);
        assertExists(responseData.job.agents);
      }
    }
  } finally {
    await transport.close();
  }
});
