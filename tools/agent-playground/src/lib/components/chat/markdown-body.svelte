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
  import { onDestroy } from "svelte";
  import { markdownToHTMLSafe } from "@atlas/ui";

  interface Props {
    content: string;
  }
  const { content }: Props = $props();

  const THROTTLE_MS = 80;

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

  onDestroy(() => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
  });
</script>

{@html html}
