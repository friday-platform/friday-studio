<script lang="ts">
  import { setExportContext, type ExportContext } from "../export-context.ts";
  import Child from "./export-context-child.svelte";

  interface Props {
    ctx: ExportContext;
  }

  const props: Props = $props();
  // svelte-ignore state_referenced_locally
  setExportContext(props.ctx);
</script>

<Child />
