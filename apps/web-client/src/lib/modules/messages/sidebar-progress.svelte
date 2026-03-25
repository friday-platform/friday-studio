<script lang="ts">
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { Icons } from "$lib/components/icons";
  import { Page } from "$lib/components/page";

  interface Props {
    messages: AtlasUIMessage[];
  }

  const { messages }: Props = $props();

  /**
   * Extract completed progress items from tool results across all messages.
   * Shows connected services, notes, and tasks.
   */
  const progressItems = $derived.by((): string[] => {
    const items: string[] = [];
    const seenProviders = new Set<string>();

    for (const message of messages) {
      for (const part of message.parts) {
        // Connected services from credential-linked events
        if (part.type === "data-credential-linked") {
          const provider = part.data?.provider;
          if (provider && !seenProviders.has(provider)) {
            seenProviders.add(provider);
            const name = String(provider)
              .split("-")
              .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ");
            items.push(`Connected to ${name}`);
          }
          continue;
        }

        // Completed progress from tool results (notes, tasks)
        if (message.role !== "assistant") continue;
        if (!part.type.startsWith("tool-")) continue;
        const output = "output" in part ? part.output : undefined;
        if (output && typeof output === "object" && output !== null && "progress" in output) {
          const progress = output.progress;
          if (
            progress &&
            typeof progress === "object" &&
            "label" in progress &&
            "status" in progress &&
            String(progress.status) === "completed"
          ) {
            const label =
              part.type === "tool-take_note" ? "Took clarifying notes" : String(progress.label);
            items.push(label);
          }
        }
      }
    }

    return items.slice(-5);
  });
</script>

<Page.SidebarSection title="Progress">
  <ul>
    {#if progressItems.length > 0}
      {#each progressItems as label (label)}
        <li class="progress-item">
          <span class="status-icon completed">
            <Icons.StyledCheckmark />
          </span>
          <span class="label">{label}</span>
        </li>
      {/each}
    {:else}
      {#each ["Ask a question", "Complete a task", "Create a space"] as label (label)}
        <li class="progress-item empty">
          <span class="status-icon">
            <Icons.StyledUnchecked />
          </span>
          <span class="label">{label}</span>
        </li>
      {/each}
    {/if}
  </ul>
</Page.SidebarSection>

<style>
  ul {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .progress-item {
    align-items: center;
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-1-5);
    line-height: var(--font-lineheight-1);
  }

  .progress-item.empty .label {
    opacity: 0.6;
  }

  .progress-item.empty .status-icon {
    opacity: 0.5;
  }

  .status-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .status-icon.completed {
    color: #439f14;

    @media (prefers-color-scheme: dark) {
      color: #88d95f;
    }

    @media (color-gamut: p3) {
      color: color(display-p3 0.2627 0.6235 0.0784);
    }

    @media (color-gamut: p3) and (prefers-color-scheme: dark) {
      color: color(display-p3 0.5329 0.8496 0.3712);
    }
  }

  .label {
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
