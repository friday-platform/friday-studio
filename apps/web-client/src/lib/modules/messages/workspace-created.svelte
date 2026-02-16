<script lang="ts">
  import {
    FSMCreatorSuccessDataSchema,
    type FSMCreatorSuccessData,
  } from "@atlas/system/agent-types";
  import { useQueryClient } from "@tanstack/svelte-query";
  import Button from "$lib/components/button.svelte";
  import { onMount } from "svelte";
  import z from "zod";
  import { MCPExecutionResultSchema } from "./types.ts";
  import MessageWrapper from "./wrapper.svelte";

  type Props = { output: unknown };
  const { output }: Props = $props();

  let queryClient = useQueryClient();

  onMount(() => {
    queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
  });

  /**
   * Schema for AgentResult envelope from execution layer.
   * System agents return payloads wrapped with metadata.
   */
  const AgentResultSchema = z.object({
    agentId: z.string(),
    timestamp: z.string(),
    input: z.unknown(),
    durationMs: z.number(),
    ok: z.literal(true),
    data: FSMCreatorSuccessDataSchema,
  });

  /** Schema for direct invocation output: { ok: true, data: FSMCreatorSuccessData } */
  const DirectResultSchema = z.object({ ok: z.literal(true), data: FSMCreatorSuccessDataSchema });

  /**
   * Parse FSMCreatorSuccessData from tool output.
   *
   * Supports two formats:
   * 1. Direct invocation: { ok: true, data: { workspaceId, ... } }
   * 2. MCP envelope: { result: { content: [{ text: JSON }] } }
   */
  const workspace: FSMCreatorSuccessData | null = $derived.by(() => {
    try {
      // Direct invocation format: { ok: true, data: { workspaceId, ... } }
      const direct = DirectResultSchema.safeParse(output);
      if (direct.success) return direct.data.data;

      // MCP envelope format: { result: { content: [{ text: JSON }] } }
      const outer = z
        .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
        .safeParse(output);
      if (!outer.success) return null;

      const mcpResult = outer.data.result.content.at(0)?.text;
      if (!mcpResult) return null;

      const parsed = JSON.parse(mcpResult);
      const executionResult = MCPExecutionResultSchema.safeParse(parsed);
      if (!executionResult.success) return null;

      const envelope = AgentResultSchema.safeParse(executionResult.data.result);
      if (envelope.success) return envelope.data.data;

      console.warn("fsm-workspace-creator result was not a success", parsed);
      return null;
    } catch (e) {
      console.error("Failed to parse fsm-workspace-creator output", e);
      return null;
    }
  });
</script>

<MessageWrapper>
  {#if workspace}
    <div class="workspace-created">
      <div class="header">
        <span class="indicator"></span>
        <h3>{workspace.workspaceName}</h3>
      </div>
      <p class="description">{workspace.workspaceDescription}</p>
      <Button href={workspace.workspaceUrl}>View</Button>
    </div>
  {/if}
</MessageWrapper>

<style>
  .workspace-created {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-4);
    border: var(--size-px) solid var(--color-border-1);
    padding: var(--size-4);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-inline-size: var(--size-112);
    gap: var(--size-3);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--size-2);
  }

  .indicator {
    width: var(--size-2);
    height: var(--size-2);
    border-radius: 50%;
    background-color: var(--color-yellow);
  }

  .header h3 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .description {
    font-size: var(--font-size-2);
    opacity: 0.7;
    margin: 0;
  }
</style>
