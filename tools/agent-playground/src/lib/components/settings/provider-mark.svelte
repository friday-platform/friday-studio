<!--
  Colored letter glyph per provider (A / O / G / Q / C). The colors match
  each vendor's brand identity so the picker stays scannable at a glance
  without needing to read every label. Size defaults to 24px square;
  `size="sm"` (18px) is used inside provider pills where the letter sits
  next to a name.
-->
<script lang="ts">
  interface Props {
    provider: string;
    letter: string;
    size?: "md" | "sm";
  }

  const { provider, letter, size = "md" }: Props = $props();
</script>

<div class="provider-mark provider-{provider}" class:size-sm={size === "sm"}>
  {letter}
</div>

<style>
  .provider-mark {
    align-items: center;
    background: var(--color-surface-5, hsl(220 8% 22%));
    border-radius: var(--radius-1, 4px);
    color: var(--color-text, hsl(40 12% 95%));
    display: grid;
    flex-shrink: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    height: 24px;
    justify-content: center;
    letter-spacing: -0.02em;
    place-items: center;
    width: 24px;
  }

  .provider-mark.size-sm {
    font-size: 10px;
    height: 18px;
    width: 18px;
  }

  /* Brand-matched backgrounds. Color values mirror the design reference
     so the UI is visually consistent with vendor brand books. */
  .provider-anthropic {
    background: #d97757;
    color: #1a1a1a;
  }
  .provider-openai {
    background: #10a37f;
    color: #fff;
  }
  .provider-google {
    background: #4285f4;
    color: #fff;
  }
  .provider-groq {
    background: #f55036;
    color: #fff;
  }
  .provider-claude-code {
    background: #b88bd3;
    color: #1a1a1a;
  }
</style>
