<script lang="ts">
type Props = { value: string; onchange: (value: string) => void; onblur: () => void };

let { value, onchange, onblur }: Props = $props();
</script>

<input
  type="text"
  placeholder="value"
  {value}
  oninput={(e) => onchange(e.currentTarget.value)}
  {onblur}
  class="value-input"
/>

<style>
  .value-input {
    background-color: transparent;
    font-size: var(--font-size-3);
    inline-size: 100%;
    opacity: 0.8;
  }

  .value-input:focus {
    outline: none;
  }
</style>
