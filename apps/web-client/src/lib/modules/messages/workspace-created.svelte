<script lang="ts">
  import {
    FSMCreatorSuccessDataSchema,
    type FSMCreatorSuccessData,
  } from "@atlas/system/agent-types";
  import { useQueryClient } from "@tanstack/svelte-query";
  import Button from "$lib/components/button.svelte";
  import { onMount } from "svelte";
  import z from "zod";
  import MessageWrapper from "./wrapper.svelte";

  type Props = { output: { result: { content: Array<{ type: string; text?: string }> } } };
  const { output }: Props = $props();

  let queryClient = useQueryClient();

  onMount(() => {
    queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
  });

  const workspace: FSMCreatorSuccessData | null = $derived.by(() => {
    try {
      const mcpResult = output.result.content.at(0)?.text;
      if (!mcpResult) return null;

      const parsed = z
        .object({ result: z.object({ data: FSMCreatorSuccessDataSchema }) })
        .parse(JSON.parse(mcpResult));

      return parsed.result.data;
    } catch (e) {
      console.error(e);
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
