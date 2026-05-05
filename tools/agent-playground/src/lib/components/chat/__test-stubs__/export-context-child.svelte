<script lang="ts">
  import { getExportContext } from "../export-context.ts";

  const ctx = getExportContext();
  const probe =
    ctx === undefined
      ? "absent"
      : JSON.stringify({
          artifactIds: Array.from(ctx.artifacts.keys()),
          resolved: ctx.resolveUrl("probe-id"),
        });
</script>

<div data-testid="probe">{probe}</div>
