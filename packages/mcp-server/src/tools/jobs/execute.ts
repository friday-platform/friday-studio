import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../types.ts";
import { type JobDirectParams, JobDirectParamsSchema } from "./schemas.ts";

export async function executeJob(
  ctx: ToolContext,
  workspaceId: string,
  jobName: string,
  params: Record<string, unknown>,
  onSessionCreated?: (session: unknown) => void,
): Promise<CallToolResult> {
  if (!ctx.workspaceProvider) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "WorkspaceProvider not available",
            code: "WORKSPACE_PROVIDER_UNAVAILABLE",
            workspaceId,
            jobName,
          }),
        },
      ],
    };
  }
  const runtime = await ctx.workspaceProvider.getOrCreateRuntime(workspaceId);
  await runtime.initialize();

  const sessionId = crypto.randomUUID();

  // Validate and normalize params
  const { payload, streamId }: JobDirectParams = JobDirectParamsSchema.parse(params);

  try {
    // Execute job directly with MCP stream emitter
    // Note: executeJobDirectly() is added in Phase 3
    const session = await runtime.executeJobDirectly(jobName, { payload, streamId });

    // Notify caller of session creation (for cancellation tracking)
    if (onSessionCreated) {
      onSessionCreated(session);
    }

    // Wait for completion - returns SessionSummary with full execution details
    const summary = await session.waitForCompletion();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: summary.status === "completed",
            status: summary.status,
            sessionId: summary.sessionId,
            duration: summary.duration,
            results: summary.results,
            ...(summary.failureReason && { failureReason: summary.failureReason }),
          }),
        },
      ],
    };
  } catch (error) {
    ctx.logger.error("Job execution failed via MCP tool", {
      error,
      jobName,
      workspaceId,
      executionPath: "mcp-tool",
    });

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string })?.code || "JOB_EXECUTION_FAILED",
            jobName,
            sessionId,
            executionPath: "mcp-tool",
          }),
        },
      ],
    };
  }
}
