<script lang="ts">
  import Message from "./daemon-loading-message.svelte";
</script>

<div class="loading">
  <Message />
</div>

<style>
  .loading {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    justify-content: center;
    padding: var(--size-10);
  }
</style>
