<script lang="ts">
import { client, parseResult } from "@atlas/client/v2";
import { ArtifactDataSchema } from "@atlas/core/artifacts";
import { z } from "zod";
import Schedule from "$lib/components/primitives/schedule.svelte";

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

{#if artifact}
	{#if artifact.type === 'calendar-schedule'}
		<Schedule
			events={artifact.data.events}
			source={artifact.data.source}
			sourceUrl={artifact.data.sourceUrl}
		/>
	{/if}
{/if}
