<script lang="ts">
  type Props = { value: string; onchange: (value: string) => void };

  let { value, onchange }: Props = $props();
</script>

<input
  type="text"
  placeholder="KEY"
  {value}
  oninput={(e) => onchange(e.currentTarget.value)}
  class="key-input"
/>

<style>
  .key-input {
    background-color: transparent;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    inline-size: 100%;
  }

  .key-input:focus {
    outline: none;
  }
</style>
