<script lang="ts">
  import { setExportContext, type ExportContext } from "../export-context.ts";
  import ArtifactCard from "../artifact-card.svelte";

  interface Props {
    ctx: ExportContext;
    artifactId: string;
  }

  const props: Props = $props();
  // svelte-ignore state_referenced_locally
  setExportContext(props.ctx);
</script>

<ArtifactCard artifactId={props.artifactId} />
