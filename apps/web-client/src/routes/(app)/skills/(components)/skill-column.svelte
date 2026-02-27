<script lang="ts">
  type Props = { name: string; description: string; muted?: boolean };

  let { name, description, muted = false }: Props = $props();
</script>

<div class="component">
  <div class="header" class:muted>{name}</div>

  <div class="details">
    <span class="description">{description}</span>
  </div>
</div>

<style>
  .component {
    overflow: hidden;
  }

  .header {
    font-weight: var(--font-weight-5);

    &.muted {
      opacity: 0.5;
    }
  }

  .details {
    align-items: center;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4);
    gap: var(--size-1);
    margin-block-start: var(--size-0-5);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .description {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    color: var(--yellow-2, #b58900);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }
</style>
