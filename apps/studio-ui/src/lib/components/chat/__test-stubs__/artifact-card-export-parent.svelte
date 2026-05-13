<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { setExportContext, type ExportContext } from "../export-context.ts";
  import ArtifactCard from "../artifact-card.svelte";

  interface Props {
    ctx: ExportContext;
    artifactId: string;
  }

  const props: Props = $props();
  // svelte-ignore state_referenced_locally
  setExportContext(props.ctx);

  // QueryClient is required by `createQuery`, even though the artifact
  // card's queries are disabled (via skipToken) in export mode — the
  // hook call still needs the context. No fetches fire.
  const queryClient = new QueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <ArtifactCard artifactId={props.artifactId} />
</QueryClientProvider>
