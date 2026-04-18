<!--
  Colored tile with the vendor's brand logomark. Anthropic/OpenAI/Groq
  get a brand-colored background with a monochrome logo on top; Google
  uses a neutral background so its multicolor G stays on-brand. Falls
  back to a letter glyph for unknown providers.

  Size defaults to 24px square; `size="sm"` (18px) is used inside
  provider pills where the logo sits next to a name.
-->
<script lang="ts">
  interface Props {
    provider: string;
    letter: string;
    size?: "md" | "sm";
  }

  const { provider, letter, size = "md" }: Props = $props();

  // The daemon reports providers in LiteLLM registry form (e.g.
  // `groq.chat`, `anthropic.messages`); friday.yml + the catalog use
  // the short form (`groq`, `anthropic`). Accept either — split on the
  // first dot so callers don't have to normalize.
  const shortProvider = $derived(provider.split(".")[0] ?? provider);
  const KNOWN = new Set(["anthropic", "openai", "google", "groq"]);
  const hasLogo = $derived(KNOWN.has(shortProvider));
</script>

<div class="provider-mark provider-{shortProvider}" class:size-sm={size === "sm"}>
  {#if hasLogo}
    <img src="/brand/{shortProvider}.svg" alt="" aria-hidden="true" />
  {:else}
    <span class="letter">{letter}</span>
  {/if}
</div>

<style>
  .provider-mark {
    align-items: center;
    background: var(--color-surface-5, hsl(220 8% 22%));
    border-radius: var(--radius-1, 4px);
    color: var(--color-text, hsl(40 12% 95%));
    display: grid;
    flex-shrink: 0;
    height: 24px;
    justify-content: center;
    place-items: center;
    width: 24px;
  }

  .provider-mark.size-sm {
    height: 18px;
    width: 18px;
  }

  .provider-mark img {
    display: block;
    height: 16px;
    width: 16px;
  }
  .provider-mark.size-sm img {
    height: 12px;
    width: 12px;
  }

  .letter {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .provider-mark.size-sm .letter {
    font-size: 10px;
  }

  /* Brand-matched backgrounds. Mono SVGs render in their own fill
     (black or currentColor-default); on these warm brand colors the
     dark mark reads well without CSS coloring. */
  .provider-anthropic {
    background: #d97757;
  }
  .provider-openai {
    background: #10a37f;
  }
  .provider-groq {
    background: #f55036;
  }
  /* Google's SVG is multicolor (blue/red/yellow/green arcs) — a white
     tile keeps the brand identity intact without fighting the logo. */
  .provider-google {
    background: #fff;
  }
</style>
