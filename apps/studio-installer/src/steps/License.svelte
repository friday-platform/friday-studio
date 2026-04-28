<script lang="ts">
import LICENSE_TEXT from "../../../../LICENSE?raw";
import { advanceStep } from "../lib/installer.ts";
import { store } from "../lib/store.svelte.ts";

function onScroll(e: Event) {
  const el = e.target as HTMLDivElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 5) {
    store.licenseScrolledToBottom = true;
  }
}

function accept() {
  store.licenseAccepted = true;
  advanceStep();
}
</script>

<div class="screen">
  <div class="header">
    <h2>License Agreement</h2>
    <p class="hint">Please scroll to the bottom to continue</p>
  </div>

  <div class="license-scroll" role="region" aria-label="License text" onscroll={onScroll}>
    <pre class="license-text">{LICENSE_TEXT}</pre>
  </div>

  <div class="footer">
    <button
      class="primary"
      disabled={!store.licenseScrolledToBottom}
      onclick={accept}
    >
      Accept &amp; Continue
    </button>
    {#if !store.licenseScrolledToBottom}
      <span class="scroll-hint">Scroll to read the full agreement</span>
    {/if}
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 0;
  }

  .header {
    padding: 28px 32px 16px;
    flex-shrink: 0;
  }

  h2 {
    font-size: 20px;
    font-weight: 700;
    color: #f0f0f0;
    margin-bottom: 4px;
  }

  .hint {
    font-size: 12px;
    color: #666;
  }

  .license-scroll {
    flex: 1;
    overflow: auto; /* allow horizontal scroll if window narrower than 76ch */
    margin: 0 32px;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    background: #131313;
    padding: 20px;
  }

  .license-text {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
    font-size: 11px;
    line-height: 1.55;
    color: #aaa;
    /* Source LICENSE hard-wraps at ~76 chars and uses indented continuation
       blocks (Parameters table). Use `pre` (no soft-wrap) so the rendered
       layout matches the source exactly — no orphaned words from CSS
       wrapping at narrower-than-source widths. */
    white-space: pre;
  }

  .footer {
    padding: 20px 32px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }

  button {
    padding: 10px 28px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .primary {
    background: #6b72f0;
    color: #fff;
  }

  .primary:hover:not(:disabled) {
    background: #5a62e0;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .scroll-hint {
    font-size: 12px;
    color: #555;
  }
</style>
