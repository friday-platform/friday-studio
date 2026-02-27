<script lang="ts">
  import { Icons } from "$lib/components/icons";
  import Tooltip from "$lib/components/tooltip.svelte";

  type Props = { disabled: boolean; needsAttention: boolean };

  let { disabled, needsAttention }: Props = $props();

  function getLabel() {
    if (disabled) {
      return "Skill is disabled";
    }

    if (needsAttention) {
      return "Missing required fields";
    }

    return "";
  }
</script>

{#if disabled || needsAttention}
  <div>
    <Tooltip label={getLabel()}>
      <Icons.Unavailable />
    </Tooltip>
  </div>
{/if}

<style>
  div {
    opacity: 0.5;
  }
</style>
