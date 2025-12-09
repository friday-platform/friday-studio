<script lang="ts">
import { client, parseResult } from "@atlas/client/v2";
import { ArtifactDataSchema } from "@atlas/core/artifacts";
import { z } from "zod";
import File from "$lib/components/primitives/file.svelte";
import Schedule from "$lib/components/primitives/schedule.svelte";
import Summary from "$lib/components/primitives/summary.svelte";
import Table from "$lib/modules/messages/table.svelte";
import MessageWrapper from "../messages/wrapper.svelte";
import WorkspacePlan from "./workspace-plan.svelte";

type Props = { artifactId: string };

let { artifactId }: Props = $props();

let artifact = $state<z.infer<typeof ArtifactDataSchema>>();

$effect(() => {
  if (artifact || !artifactId) return;

  async function grabArtifact() {
    try {
      const result = (await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: artifactId }, query: {} }),
      )) as unknown as { ok: boolean; data: { artifact: { data: unknown } } };

      if (!result.ok) throw new Error("Failed to get artifact");

      artifact = ArtifactDataSchema.parse(result.data.artifact.data);
    } catch (error) {
      console.error(error);
    }
  }

  grabArtifact();
});
</script>

<MessageWrapper>
	{#if artifact}
		<div id={`artifact-${artifactId}`}>
			{#if artifact.type === 'calendar-schedule'}
				<Schedule
					events={artifact.data.events}
					source={artifact.data.source}
					sourceUrl={artifact.data.sourceUrl}
				/>
			{:else if artifact.type === 'summary'}
				<Summary data={artifact.data} />
			{:else if artifact.type === 'slack-summary'}
				<Summary data={artifact.data} source="slack" />
			{:else if artifact.type === 'workspace-plan'}
				<WorkspacePlan workspacePlan={artifact.data} />
			{:else if artifact.type === 'table'}
				<Table data={artifact.data} />
			{:else if artifact.type === 'file'}
				<File data={artifact.data} {artifactId} />
			{/if}
		</div>
	{/if}
</MessageWrapper>
