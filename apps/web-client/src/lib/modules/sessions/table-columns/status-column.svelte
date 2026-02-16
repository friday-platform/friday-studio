<script lang="ts">
  type Props = { status: string };
  let { status }: Props = $props();
</script>

<div class="component">
  <span class="details">
    {status}
  </span>
</div>

<style>
  .component {
    align-items: end;
    block-size: 100%;
    display: flex;

    justify-content: space-between;
    padding-block-end: var(--size-3);

    .details {
      align-items: center;
      display: flex;
      justify-content: space-between;
      inline-size: 100%;
      gap: var(--size-1);
    }
  }
</style>
