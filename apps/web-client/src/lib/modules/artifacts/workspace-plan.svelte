<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import {
    ArtifactDataSchema,
    type ArtifactWithContents,
    type WorkspacePlan,
  } from "@atlas/core/artifacts";
  import MessageWrapper from "$lib/modules/messages/wrapper.svelte";
  import { getContext } from "svelte";
  import WorkspacePlanDetails from "./workspace-plan-details.svelte";

  const ARTIFACTS_KEY = Symbol.for("artifacts");

  type Props = { artifactId: string };

  let { artifactId }: Props = $props();

  const artifactsMap = getContext<Map<string, ArtifactWithContents> | undefined>(ARTIFACTS_KEY);

  let workspacePlan = $state<WorkspacePlan>();

  $effect(() => {
    if (workspacePlan || !artifactId) return;

    // Check context first (batch-loaded artifacts)
    const cached = artifactsMap?.get(artifactId);
    if (cached) {
      const parsed = ArtifactDataSchema.parse(cached.data);
      if (parsed.type === "workspace-plan") {
        workspacePlan = parsed.data;
      }
      return;
    }

    // Fallback: fetch individually (streaming case)
    async function grabArtifact() {
      try {
        const result = await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id: artifactId }, query: {} }),
        );

        if (!result.ok) throw new Error("Failed to get artifact");

        const parsed = ArtifactDataSchema.parse(result.data.artifact.data);
        if (parsed.type === "workspace-plan") {
          workspacePlan = parsed.data;
        }
      } catch (error) {
        console.error(error);
      }
    }

    grabArtifact();
  });
</script>

<MessageWrapper>
  {#if workspacePlan}
    <div id={`artifact-${artifactId}`}>
      <WorkspacePlanDetails {workspacePlan} />
    </div>
  {/if}
</MessageWrapper>
