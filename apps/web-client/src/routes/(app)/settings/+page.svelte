<script lang="ts">
import { onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import { BUILD_INFO } from "$lib/build-info";
import { Icons } from "$lib/components/icons";
import { getVersion, invoke } from "$lib/utils/tauri-loader";

const ctx = getAppContext();

let envVars = $state<{ key: string; value: string; id: number }[]>([]);
let isSaving = $state(false);
let isRestarting = $state(false);
let message = $state("");
let nextId = 1;

let version = $state<string>(BUILD_INFO?.version || "0.1.0");
let buildType = BUILD_INFO?.buildType || "development";
let commitHash = BUILD_INFO?.commitHash || "unknown";

onMount(async () => {
  // Load env vars from daemon API (works in both web and desktop)
  loadEnvVars();

  // Get version info from Tauri if available
  if (getVersion) {
    try {
      const tauriVersion = await getVersion();
      if (tauriVersion) {
        version = tauriVersion;
      }
    } catch {
      // Failed to get Tauri version, use build info version
    }
  }
});

async function loadEnvVars() {
  try {
    const result = await ctx.daemonClient.getEnvVars();
    // Sort entries by key alphabetically
    envVars = Object.entries(result)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value, id: nextId++ }));
  } catch (err) {
    console.error("Failed to load env vars:", err);
  }
}

function addEntry() {
  envVars = [...envVars, { key: "", value: "", id: nextId++ }];
}

async function removeEntry(id: number) {
  envVars = envVars.filter((v) => v.id !== id);
  await saveChanges();
}

async function saveChanges() {
  isSaving = true;

  try {
    // Only save entries that have both key and value
    const validEntries = envVars.filter((v) => v.key.trim() !== "" && v.value.trim() !== "");
    const envObject: Record<string, string> = {};

    for (const entry of validEntries) {
      envObject[entry.key.trim()] = entry.value;
    }

    await ctx.daemonClient.setEnvVars(envObject);
  } catch (err) {
    console.error("Failed to save env vars:", err);
    alert("Failed to save environment variables");
  } finally {
    isSaving = false;
  }
}

async function restartDaemon() {
  if (!invoke) return;

  isRestarting = true;
  try {
    const result = (await invoke("restart_atlas_daemon")) as string;
    showMessage(result);
  } catch (err) {
    console.error("Failed to restart daemon:", err);
    alert("Failed to restart Atlas daemon");
  } finally {
    isRestarting = false;
  }
}

function showMessage(msg: string) {
  message = msg;

  setTimeout(() => {
    message = "";
  }, 5000);
}
</script>

<div class="main">
	<div class="main-int">
		<h1>Settings</h1>

		<h2>Environment Variables</h2>

		<div class="list" role="table">
			<div class="list-header">
				<span class="list-heading">Key</span>
				<span class="list-heading">Value</span>
				<span class="list-heading">&nbsp;</span>
			</div>

			{#each envVars as entry (entry.id)}
				<div class="list-row">
					<div class="list-cell">
						<input
							type="text"
							placeholder="KEY"
							bind:value={() => entry.key, (v) => (entry.key = v)}
							class="key-input"
						/>
					</div>

					<div class="list-cell">
						<input
							type="text"
							placeholder="value"
							bind:value={() => entry.value, (v) => (entry.value = v)}
							onblur={() => {
								saveChanges();
							}}
							class="value-input"
						/>
					</div>

					<div class="list-cell">
						<button
							type="button"
							class="remove-button"
							onclick={() => removeEntry(entry.id)}
							aria-label="Remove entry"
						>
							<Icons.Trash />
						</button>
					</div>
				</div>
			{/each}
		</div>

		<button class="add-button" onclick={addEntry}>
			<Icons.Plus />
			Add Variable
		</button>

		{#if __TAURI_BUILD__}
			<div class="daemon-section">
				<h2>Daemon</h2>

				<p>This operation may take a second.</p>

				<button class="restart-daemon-button" onclick={restartDaemon} disabled={isRestarting}>
					{isRestarting ? 'Restarting...' : 'Restart Daemon'}
				</button>

				{#if message}
					<p class="daemon-message">
						{message}
					</p>
				{/if}
			</div>
		{/if}

		<div class="version-info">
			<h2>App Details</h2>

			<p>
				Version {version} ({commitHash})
				<br />
				{buildType}
			</p>
		</div>
	</div>
</div>

<style>
	.main {
		block-size: 100%;
		inline-size: 100%;
		overflow: auto;
		padding-block: var(--size-14);
		padding-inline: var(--size-16);
		position: relative;
		transition: all 150ms ease;
		z-index: var(--layer-1);
	}

	.main-int {
		max-inline-size: var(--size-216);
		margin-inline: auto;
	}

	h1 {
		color: var(--color-text);
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-6);
		line-height: var(--font-lineheight-1);
		font-weight: 600;
		margin-block-end: var(--size-4);
	}

	.version-info {
		margin-block-start: var(--size-8);
	}

	h2 {
		color: var(--color-text);
		/* @TODO: update to style guide value */
		font-size: 18px;
		font-weight: var(--font-weight-6);
		line-height: var(--font-lineheight-1);
		font-weight: 600;
	}

	p {
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-4);
		line-height: var(--font-lineheight-1);
		margin-block: var(--size-1-5) var(--size-4);
		opacity: 0.8;
	}

	button {
		align-items: center;
		block-size: var(--size-7);
		border-radius: var(--radius-3);
		box-shadow: var(--shadow-1);
		display: flex;
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
		gap: var(--size-1-5);
		padding-inline: var(--size-2-5) var(--size-3);
		transition: all 0.2s ease;

		&:hover:not(:disabled) {
			background: color-mix(in srgb, var(--color-text) 3%, transparent);
		}

		&:disabled {
			opacity: 0.8;
			cursor: not-allowed;
		}
	}

	.list {
		& {
			display: grid;
			grid-template-columns: var(--size-64) 1fr var(--size-10);
			inline-size: 100%;
			margin-block-end: var(--size-4);
		}

		.list-header {
			display: grid;
			grid-template-columns: subgrid;
			grid-column: 1 / -1;
		}

		.list-heading,
		.list-cell {
			border-bottom: 1px solid var(--color-border-1);
			font-size: var(--font-size-4);

			text-align: left;
			padding-block: var(--size-2);
		}

		.list-heading {
			font-weight: var(--font-weight-6);
		}

		.list-row {
			display: grid;
			grid-template-columns: subgrid;
			grid-column: 1 / -1;
		}

		.key-input,
		.value-input {
			inline-size: 100%;
			opacity: 0.8;
			transition: border-color 0.2s;
		}

		.key-input {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-6);
		}

		.value-input {
			font-size: var(--font-size-3);
		}

		.key-input:focus,
		.value-input:focus {
			outline: none;
			border-color: var(--accent-1, #007bff);
		}

		.remove-button {
			align-items: center;
			background: none;
			box-shadow: none;
			color: color-mix(in srgb, var(--color-text) 80%, transparent);
			display: flex;
			inline-size: var(--size-8);
			justify-content: center;
			margin-inline-start: auto;
			opacity: 0;
			padding: 0;
			transition:
				opacity 0.2s ease,
				color 0.2s ease;
		}

		.remove-button:hover {
			background: none;
			color: var(--color-red);
		}

		.remove-button:focus,
		.list-row:hover .remove-button {
			opacity: 1;
			outline: none;
		}

		.remove-button:focus-within {
			outline: 1px solid var(--color-border-1);
		}
	}

	.daemon-section {
		margin-block-start: var(--size-12);

		.restart-daemon-button {
			color: var(--color-red);
			padding-inline-start: var(--size-3);
		}

		.daemon-message {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			opacity: 0.5;
		}
	}
</style>
