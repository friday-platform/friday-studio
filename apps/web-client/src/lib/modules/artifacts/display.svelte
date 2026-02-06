<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { ArtifactDataSchema, type ArtifactWithContents } from "@atlas/core/artifacts";
  import BasicTable from "$lib/components/primitives/basic-table.svelte";
  import Document from "$lib/components/primitives/document.svelte";
  import File from "$lib/components/primitives/file.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import Schedule from "$lib/components/primitives/schedule.svelte";
  import WebSearch from "$lib/components/primitives/web-search.svelte";
  import MessageWrapper from "$lib/modules/messages/wrapper.svelte";
  import { getContext } from "svelte";
  import { z } from "zod";
  import SkillDraft from "./skill-draft.svelte";
  import WorkspacePlan from "./workspace-plan.svelte";

  const ARTIFACTS_KEY = Symbol.for("artifacts");

  type Props = { artifactId: string };

  let { artifactId }: Props = $props();

  const artifactsMap = getContext<Map<string, ArtifactWithContents> | undefined>(ARTIFACTS_KEY);

  let artifact = $state<z.infer<typeof ArtifactDataSchema>>();
  let contents = $state<string | undefined>(undefined);

  $effect(() => {
    if (artifact || !artifactId) return;

    // Check context first (batch-loaded artifacts)
    const cached = artifactsMap?.get(artifactId);
    if (cached) {
      artifact = ArtifactDataSchema.parse(cached.data);
      contents = cached.contents;
      return;
    }

    // Fallback: fetch individually (streaming case)
    async function grabArtifact() {
      try {
        const result = await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id: artifactId }, query: {} }),
        );

        if (!result.ok) throw new Error("Failed to get artifact");

        artifact = ArtifactDataSchema.parse(result.data.artifact.data);
        contents = result.data.contents;
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
      {#if artifact.type === "calendar-schedule"}
        <Schedule
          events={artifact.data.events}
          source={artifact.data.source}
          sourceUrl={artifact.data.sourceUrl}
        />
      {:else if artifact.type === "web-search"}
        <WebSearch data={artifact.data} />
      {:else if artifact.type === "summary"}
        <Document name="Search Result">
          <div class="summary">
            <MarkdownContent content={artifact.data} />
          </div>
        </Document>
      {:else if artifact.type === "slack-summary"}
        <Document name="Slack Summary">
          <div class="summary">
            <MarkdownContent content={artifact.data} />
          </div>
        </Document>
      {:else if artifact.type === "workspace-plan"}
        <WorkspacePlan {artifactId} onApprove={() => {}} onTest={() => {}} />
      {:else if artifact.type === "skill-draft"}
        <SkillDraft skillDraft={artifact.data} />
      {:else if artifact.type === "table"}
        <Document name="Table">
          <BasicTable headers={artifact.data.headers} rows={artifact.data.rows} />
        </Document>
      {:else if artifact.type === "file"}
        <File data={artifact.data} {contents} />
      {/if}
    </div>
  {/if}
</MessageWrapper>

<style>
  .summary {
    padding: var(--size-6);
  }
</style>
