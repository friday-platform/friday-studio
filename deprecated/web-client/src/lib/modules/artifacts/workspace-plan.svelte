<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { ArtifactDataSchema, type ArtifactWithContents } from "@atlas/core/artifacts";
  import type { WorkspaceBlueprint } from "@atlas/schemas/workspace";
  import MessageWrapper from "$lib/modules/messages/wrapper.svelte";
  import { getContext } from "svelte";
  import WorkspacePlanDetails from "./workspace-plan-details.svelte";

  const ARTIFACTS_KEY = Symbol.for("artifacts");

  type Props = { artifactId: string; onApprove: () => void; onTest: () => void };

  let { artifactId, onApprove, onTest }: Props = $props();

  const artifactsMap = getContext<Map<string, ArtifactWithContents> | undefined>(ARTIFACTS_KEY);

  /** Extracts the plan card data from a parsed workspace-plan artifact (v1 or v2). */
  function extractPlanData(
    parsed: ReturnType<typeof ArtifactDataSchema.parse>,
  ): Parameters<typeof WorkspacePlanDetails>[1]["workspacePlan"] | undefined {
    if (parsed.type !== "workspace-plan") return undefined;
    if (parsed.version === 1) return parsed.data;
    // v2 WorkspaceBlueprint — map to the common plan card shape
    return {
      workspace: parsed.data.workspace,
      signals: parsed.data.signals,
      credentials: parsed.data.credentialBindings,
      resources: parsed.data.resources,
      credentialCandidates: parsed.data.credentialCandidates,
    };
  }

  /** Extracts the full v2 blueprint for artifact PUT on credential selection. */
  function extractBlueprint(
    parsed: ReturnType<typeof ArtifactDataSchema.parse>,
  ): WorkspaceBlueprint | undefined {
    if (parsed.type !== "workspace-plan" || parsed.version !== 2) return undefined;
    return parsed.data;
  }

  let planData = $state<Parameters<typeof WorkspacePlanDetails>[1]["workspacePlan"]>();
  let blueprint = $state<WorkspaceBlueprint>();
  let artifactSummary = $state("");

  $effect(() => {
    if (planData || !artifactId) return;

    // Check context first (batch-loaded artifacts)
    const cached = artifactsMap?.get(artifactId);
    if (cached) {
      const parsed = ArtifactDataSchema.parse(cached.data);
      planData = extractPlanData(parsed);
      blueprint = extractBlueprint(parsed);
      artifactSummary = cached.summary ?? "";
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
        planData = extractPlanData(parsed);
        blueprint = extractBlueprint(parsed);
        artifactSummary = result.data.artifact.summary ?? "";
      } catch (error) {
        console.error(error);
      }
    }

    grabArtifact();
  });

  /**
   * Persists the final credential selections to the artifact, then approves.
   * Strips credentialCandidates — they're UI-only metadata, not needed downstream.
   */
  async function handleApprove(credentials?: Map<string, string>) {
    if (credentials && credentials.size > 0 && blueprint) {
      const updatedBindings = (blueprint.credentialBindings ?? []).map((binding) => {
        const selectedId = credentials.get(binding.provider);
        if (!selectedId) return binding;
        return { ...binding, credentialId: selectedId };
      });

      const { credentialCandidates: _, ...rest } = blueprint;
      const updatedBlueprint = { ...rest, credentialBindings: updatedBindings };

      await parseResult(
        client.artifactsStorage[":id"].$put({
          param: { id: artifactId },
          json: {
            type: "workspace-plan",
            data: { type: "workspace-plan", version: 2, data: updatedBlueprint },
            summary: artifactSummary,
            revisionMessage: "Confirmed credential selection",
          },
        }),
      );
    }

    onApprove();
  }
</script>

<MessageWrapper>
  {#if planData}
    <div id={`artifact-${artifactId}`}>
      <WorkspacePlanDetails workspacePlan={planData} onApprove={handleApprove} {onTest} />
    </div>
  {/if}
</MessageWrapper>
