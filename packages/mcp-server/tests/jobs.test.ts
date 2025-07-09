import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Jobs Tools - list", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First get a workspace ID
    const workspaceResult = await client.callTool({
      name: "atlas_workspace_list",
      arguments: {},
    });

    const workspaceContent = workspaceResult.content as Array<{ type: string; text: string }>;
    const workspaceTextContent = workspaceContent.find((item) => item.type === "text");
    const workspaceData = JSON.parse(workspaceTextContent!.text);

    if (workspaceData.workspaces.length > 0) {
      const workspaceId = workspaceData.workspaces[0].id;

      const result = await client.callTool({
        name: "atlas_workspace_jobs_list",
        arguments: {
          workspaceId: workspaceId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have jobs array
      assertExists(responseData.jobs);
      assertEquals(Array.isArray(responseData.jobs), true);

      // Should have workspace info
      assertExists(responseData.workspace);
      assertEquals(responseData.workspace.id, workspaceId);
    }
  } finally {
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
