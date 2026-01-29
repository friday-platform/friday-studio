<script lang="ts">
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import { formatOutlineDate } from "$lib/utils/date";
  import OutlineItemDescription from "./outline-item-description.svelte";

  let { messages }: { messages: AtlasUIMessage[] } = $props();
</script>

{#if messages.length > 0}
  <div class="component">
    {#each messages as message (message.id)}
      {#each message.parts as part, index (index)}
        {#if part.type === "data-outline-update"}
          {@const serviceIcon = getServiceIcon(part.data.id)}
          <article>
            <header>
              <h2>
                {#if serviceIcon}
                  {#if serviceIcon.type === "component"}
                    {@const Component = serviceIcon.src}
                    <Component />
                  {:else}
                    <img src={serviceIcon.src} alt={part.data.id} />
                  {/if}
                {/if}

                {part.data.title}
              </h2>

              <time>{formatOutlineDate(part.data.timestamp)}</time>
            </header>

            {#if part.data.content}
              <OutlineItemDescription content={part.data.content} />
            {/if}

            {#if part.data.artifactId}
              <a
                href={`#artifact-${part.data.artifactId}`}
                onclick={(e) => {
                  const match = document.getElementById(`artifact-${part.data.artifactId}`);
                  if (match) {
                    e.preventDefault();

                    match.scrollIntoView({ behavior: "smooth" });
                  }
                }}
              >
                {part.data.artifactLabel ?? "View"}
              </a>
            {/if}
          </article>
        {/if}
      {/each}
    {/each}
  </div>
{/if}

<style>
  .component {
    block-size: max-content;
    max-block-size: calc(100dvh - var(--size-16));
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: var(--size-6);
    inline-size: var(--size-56);
    overflow: auto;
    inset-block-start: var(--size-10);
    inset-inline-end: 0;
    scrollbar-width: none;
    padding-inline-end: var(--size-10);
    padding-block-end: var(--size-20);
    position: fixed;
    z-index: var(--layer-2);
  }

  article {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);

    h2 {
      color: color-mix(in srgb, var(--color-text) 90%, transparent);
      display: flex;
      align-items: center;
      gap: var(--size-1);
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-0);

      :global(svg),
      img {
        block-size: var(--size-4);
        flex-shrink: 0;
        inline-size: var(--size-4);
      }
    }

    time {
      font-size: var(--font-size-1);
      opacity: 0.7;
    }

    a {
      font-size: var(--font-size-1);
      opacity: 0.7;
      text-decoration-style: dotted;
      text-decoration-line: underline;
      font-weight: var(--font-weight-5);
      text-underline-offset: var(--size-0-5);
      transition: opacity 0.2s ease-in-out;

      &:hover {
        opacity: 1;
      }
    }
  }
</style>
