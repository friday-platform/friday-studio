<script lang="ts">
  /**
   * Throttled markdown renderer for streamed assistant messages.
   *
   * `markdownToHTMLSafe` runs `marked.parse` + `DOMPurify.sanitize` —
   * about 300us per call on a typical assistant message. During a live
   * stream `content` mutates 30–100 times per second; the inline
   * `{@html markdownToHTMLSafe(content)}` callsite re-paid that cost on
   * every chunk, multiplied by every visible prose segment. That was
   * the dominant on-thread work during streaming.
   *
   * This component renders synchronously on first mount (so the message
   * appears immediately) and then throttles subsequent re-renders to
   * `THROTTLE_MS` while content keeps changing. Once content stops
   * mutating, the trailing flush captures the final value — no
   * dropped frames at the end of streaming.
   *
   * Non-streaming history takes the no-op path: `content` doesn't
   * change, so the effect's early bail keeps the cached HTML.
   */
  import { onDestroy, untrack } from "svelte";
  import { markdownToHTMLSafe } from "@atlas/ui";

  interface Props {
    content: string;
    /**
     * False while this message is mid-stream. When the parent flips it
     * to true (stream ended or message became non-tail), we flush any
     * in-flight 80ms throttle synchronously so the final `{@html}` write
     * lands *before* downstream observers (notably the `copyButtons`
     * action that wraps `<pre>`/`<table>`) start mutating Svelte-owned
     * DOM. Without this, the trailing throttle could fire after a wrap
     * and silently corrupt Svelte's `{@html}` anchor refs — the same
     * bubble-blanking bug the gating is meant to prevent.
     */
    settled?: boolean;
  }
  const { content, settled = true }: Props = $props();

  // 80ms (12 fps) chewed enough CPU on `marked.parse` + `DOMPurify.sanitize`
  // calls during a 50-row table stream that the renderer couldn't keep up
  // with the chunk rate. 120ms (≈8 fps) is still well under the perceptual
  // threshold for "streaming", and the trailing flush on `settled` lands the
  // final content immediately so the user never sees a stale tail.
  const THROTTLE_MS = 120;

  let html = $state(markdownToHTMLSafe(content));
  let lastRendered = content;
  let pending: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    // Subscribe to `content`. Bail when it hasn't changed since the
    // last commit, or when a flush is already scheduled.
    const next = content;
    if (next === lastRendered) return;
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      lastRendered = content;
      html = markdownToHTMLSafe(content);
    }, THROTTLE_MS);
  });

  $effect(() => {
    // Flush a pending throttle when `settled` flips true. Reads `content`
    // through `untrack` so this effect doesn't re-fire on every content
    // delta — that path already has its own throttle effect above.
    if (!settled) return;
    if (pending === null) return;
    clearTimeout(pending);
    pending = null;
    untrack(() => {
      lastRendered = content;
      html = markdownToHTMLSafe(content);
    });
  });

  onDestroy(() => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
  });
</script>

{@html html}
