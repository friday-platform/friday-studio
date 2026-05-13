<!--
  ConnectCommunicator — chat-rendered card that wires an external chat
  platform (Slack, Telegram, Discord, Teams, WhatsApp) as a conversation
  surface for the current workspace.

  Mirrors the connect-service flow but for communicators rather than
  services Friday calls as tools. Telegram is the tracer-bullet kind: this
  component renders the inline apikey form for telegram and a "use the
  integrations sidebar" hint for the other four kinds (T3 generalizes).

  On successful wire the parent's `onConnected` is called so it can nudge
  the agent to continue.

  @component
  @prop kind - Communicator kind from the tool input
  @prop onConnected - Called after the wire mutation succeeds
-->

<script lang="ts">
  import { page } from "$app/stores";
  import CommunicatorApiKeyForm from "$lib/components/shared/communicator-apikey-form.svelte";

  type CommunicatorKind = "slack" | "telegram" | "discord" | "teams" | "whatsapp";

  interface Props {
    kind: CommunicatorKind;
    onConnected?: () => void;
  }

  const { kind, onConnected }: Props = $props();

  const KIND_DISPLAY_NAMES: Record<CommunicatorKind, string> = {
    slack: "Slack",
    telegram: "Telegram",
    discord: "Discord",
    teams: "Microsoft Teams",
    whatsapp: "WhatsApp",
  };

  // Workspace ID lives in the route params for `/platform/[workspaceId]/...`
  // pages — the only routes that render the chat. Empty fallback keeps
  // the component renderable in storybook-style isolation.
  const workspaceId = $derived(($page.params.workspaceId as string | undefined) ?? "");

  let connected = $state(false);

  function handleConnected() {
    connected = true;
    onConnected?.();
  }
</script>

<div class="connect-communicator-card">
  {#if connected}
    <div class="success-state">
      <span class="success-icon">✓</span>
      <span class="success-text">
        {KIND_DISPLAY_NAMES[kind]} connected. Continue your conversation here or in {KIND_DISPLAY_NAMES[kind]}.
      </span>
    </div>
  {:else}
    <div class="header">
      <div class="header-text">
        <h3>Connect {KIND_DISPLAY_NAMES[kind]}</h3>
        <p class="description">
          Wire {KIND_DISPLAY_NAMES[kind]} as a surface for this conversation. Once connected, you can
          chat with Friday from {KIND_DISPLAY_NAMES[kind]}.
        </p>
      </div>
    </div>

    {#if kind === "telegram"}
      {#if workspaceId}
        <CommunicatorApiKeyForm
          {workspaceId}
          {kind}
          onConnected={handleConnected}
        />
      {:else}
        <p class="form-error">No workspace context — open this chat from a workspace page.</p>
      {/if}
    {:else}
      <p class="not-supported">
        Connecting {KIND_DISPLAY_NAMES[kind]} from chat is not yet supported. Use the integrations
        sidebar on the workspace page to wire it.
      </p>
    {/if}
  {/if}
</div>

<style>
  .connect-communicator-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-3) var(--size-4);
    max-inline-size: 480px;
  }

  .header {
    align-items: flex-start;
    display: flex;
    gap: var(--size-2);
  }

  .header-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .header-text h3 {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .description {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    line-height: 1.45;
    margin: 0;
  }

  .not-supported {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
  }

  .form-error {
    background: color-mix(in srgb, var(--color-error), transparent 90%);
    border: 1px solid var(--color-error);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-1);
    margin: 0;
    padding: var(--size-2) var(--size-3);
  }

  .success-state {
    align-items: center;
    color: var(--color-success);
    display: flex;
    gap: var(--size-2);
    font-size: var(--font-size-2);
  }

  .success-icon {
    background: var(--color-success);
    border-radius: 50%;
    color: white;
    display: inline-flex;
    font-size: 12px;
    font-weight: bold;
    inline-size: 20px;
    block-size: 20px;
    justify-content: center;
    line-height: 20px;
  }
</style>
