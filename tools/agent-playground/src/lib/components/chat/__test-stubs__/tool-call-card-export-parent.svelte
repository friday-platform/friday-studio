<script lang="ts">
  import { setExportContext, type ExportContext } from "../export-context.ts";
  import ToolCallCard from "../tool-call-card.svelte";
  import type { ToolCallDisplay } from "../types.ts";

  interface Props {
    ctx?: ExportContext;
    call: ToolCallDisplay;
  }

  const props: Props = $props();
  // svelte-ignore state_referenced_locally
  if (props.ctx) setExportContext(props.ctx);
</script>

<ToolCallCard call={props.call} />
