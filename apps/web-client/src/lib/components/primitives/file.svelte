<script lang="ts">
import { client, parseResult } from "@atlas/client/v2";
import { type FileData } from "@atlas/core/artifacts";
import { createCollapsible } from "@melt-ui/svelte";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import { toast } from "$lib/components/notification/notification.svelte";
import { copyToClipboard, downloadCsv, downloadJson, getUniqueFileName } from "$lib/utils/files";
import { BaseDirectory, openFile, openPath, writeTextFile } from "$lib/utils/tauri-loader";

type Props = { data: FileData; artifactId: string };

let { data, artifactId }: Props = $props();

const {
  elements: { root, trigger, content },
  states: { open },
} = createCollapsible({ forceVisible: true });

const fileName = $derived.by(() => {
  const paths = data.path.split("/");
  return paths[paths.length - 1];
});

let fileContents = $state<string | undefined>();

async function fetchFile() {
  const result = await parseResult(
    client.artifactsStorage[":id"].contents.$get({ param: { id: artifactId }, query: {} }),
  );

  if (!result.ok) {
    console.warn("Failed to fetch file contents");
  } else {
    fileContents = result.data.contents;
  }
}

$effect(() => {
  if (artifactId) {
    fetchFile();
  }
});

async function handleDownload(content: string) {
  if (__TAURI_BUILD__ && writeTextFile && BaseDirectory) {
    try {
      const uniqueName = await getUniqueFileName(fileName, BaseDirectory.Download);
      await writeTextFile(uniqueName, content, { baseDir: BaseDirectory.Download });

      toast({
        title: "Done",
        description: `${uniqueName} has been downloaded.`,
        viewLabel: "View File",
        viewAction: () => handleOpenInFinder(uniqueName),
      });
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  } else {
    if (data.mimeType === "text/csv") {
      downloadCsv(fileName, content);
    } else {
      downloadJson(fileName, content);
    }
  }
}

async function handleOpenInFinder(savedFileName: string) {
  if (!openPath || !BaseDirectory.Download) return;
  try {
    await openFile(savedFileName, { read: true, baseDir: BaseDirectory.Download });
  } catch (e) {
    console.error("Failed to open downloads folder:", e);
  }
}
</script>

{#if data}
	<article class="container" {...$root} use:root>
		<header>
			<DropdownMenu.Root
				positioning={{
					placement: 'bottom-end'
				}}
			>
				<DropdownMenu.Trigger>
					<h2>{fileName} <IconSmall.CaretDown /></h2>
				</DropdownMenu.Trigger>

				<DropdownMenu.Content>
					<DropdownMenu.List>
						<DropdownMenu.Item
							onclick={() => {
								if (!fileContents) return;

								handleDownload(fileContents);
							}}
						>
							Download File
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Label>Copy</DropdownMenu.Label>
						<DropdownMenu.Item
							onclick={() => {
								if (!fileContents) return;
								copyToClipboard(fileContents);
							}}
						>
							Text
						</DropdownMenu.Item>
						<DropdownMenu.Item
							onclick={() => {
								copyToClipboard(fileName);
							}}
						>
							File Name
						</DropdownMenu.Item>
					</DropdownMenu.List>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</header>

		<div class="contents" use:content {...$content} class:expanded={$open}>
			{#if fileContents}
				<pre><code>{fileContents}</code></pre>
			{/if}
		</div>

		{#if !$open}
			<div class="expand">
				<button type="button" {...$trigger} use:trigger>
					<Icons.DoubleArrow />
					Expand
				</button>
			</div>
		{/if}
	</article>
{/if}

<style>
	article {
		background-color: var(--color-surface-2);
		border-radius: var(--radius-6);
		max-inline-size: 100%;
		inline-size: fit-content;
		overflow: hidden;
		padding: var(--size-0-5);
		position: relative;

		header {
			align-items: center;
			block-size: var(--size-10);
			display: flex;
			padding-inline: var(--size-3);

			h2 {
				align-items: center;
				display: flex;
				gap: var(--size-1);
				font-size: var(--font-size-2);
			}
		}
	}

	.expand {
		align-items: end;
		background: linear-gradient(to bottom, transparent, var(--color-surface-1) 90%);
		border-radius: var(--radius-5);
		display: flex;
		justify-content: center;
		inset-block: var(--size-10) var(--size-0-5);
		inset-inline: var(--size-0-5);
		position: absolute;
		padding-block: var(--size-4);
		z-index: var(--layer-1);

		button {
			align-items: center;
			color: var(--color-blue);
			display: flex;
			gap: var(--size-1);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
		}
	}

	.contents {
		background-color: var(--color-surface-1);
		border-radius: var(--radius-5);
		max-block-size: var(--size-48);
		padding: var(--size-4);
		overflow: hidden;

		&.expanded {
			max-block-size: none;
			overflow: auto;
		}

		pre {
			margin: 0;
			white-space: pre;
			word-wrap: normal;

			code {
				font-family: var(--font-mono);
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-5);
			}
		}

		.error {
			color: var(--color-error);
		}

		.unsupported,
		.loading {
			color: var(--color-text-muted);
			font-style: italic;
		}
	}

	.download-toast {
		align-items: center;
		background-color: var(--color-surface-3);
		border-radius: var(--radius-4);
		bottom: var(--size-2);
		display: flex;
		font-size: var(--font-size-2);
		gap: var(--size-3);
		left: 50%;
		padding: var(--size-2) var(--size-4);
		position: absolute;
		transform: translateX(-50%);
		z-index: var(--layer-2);

		button {
			color: var(--color-blue);
			font-weight: var(--font-weight-5);
		}
	}
</style>
