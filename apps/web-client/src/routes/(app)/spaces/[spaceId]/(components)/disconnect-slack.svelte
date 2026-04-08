<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { stringifyError } from "@atlas/utils";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { Icons } from "$lib/components/icons";
  import { toast } from "$lib/components/notification/notification.svelte";

  let { workspaceId }: { workspaceId: string } = $props();

  let busy = $state(false);

  async function handleDisconnect() {
    if (busy) return;
    busy = true;

    const res = await parseResult(
      client.workspace[":workspaceId"]["disconnect-slack"].$post({ param: { workspaceId } }),
    );

    busy = false;

    if (!res.ok) {
      toast({
        title: "Failed to disconnect Slack",
        description: stringifyError(res.error),
        error: true,
      });
      return;
    }

    const resData: unknown = res.data;
    const deletedApp =
      typeof resData === "object" &&
      resData !== null &&
      "deletedApp" in resData &&
      resData.deletedApp === true;
    toast({
      title: "Slack disconnected",
      description: deletedApp
        ? "Slack app removed from this space."
        : "Chat events disabled. Slack app kept because it's still used by this space.",
    });
    await invalidateAll();
  }
</script>

<Dialog.Root>
  <Dialog.Trigger>
    <Button size="small" variant="secondary" noninteractive>Disconnect</Button>
  </Dialog.Trigger>

  <Dialog.Content>
    <Dialog.Close />

    {#snippet icon()}
      <span style:color="var(--color-red)">
        <Icons.Slack />
      </span>
    {/snippet}

    {#snippet header()}
      <Dialog.Title>Turn off Slack chat?</Dialog.Title>
      <Dialog.Description>
        <p>
          You'll stop receiving Slack mentions for this space. If nothing else in the space uses the
          Slack app, it will also be removed from Slack.
        </p>
      </Dialog.Description>
    {/snippet}

    {#snippet footer()}
      <Dialog.Button onclick={handleDisconnect} disabled={busy}>
        {busy ? "Turning off..." : "Turn off"}
      </Dialog.Button>
      <Dialog.Cancel>Cancel</Dialog.Cancel>
    {/snippet}
  </Dialog.Content>
</Dialog.Root>
