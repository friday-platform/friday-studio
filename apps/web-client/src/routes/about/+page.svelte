<script lang="ts">
import { onMount } from "svelte";
import logo from "$lib/assets/logo.png";
// Import build info if it exists (will be generated at build time)
import { BUILD_INFO } from "$lib/build-info";
import { getVersion } from "$lib/utils/tauri-loader";

let version = $state<string>(BUILD_INFO?.version || "0.1.0");
let buildType = BUILD_INFO?.buildType || "development";
let commitHash = BUILD_INFO?.commitHash || "unknown";

onMount(async () => {
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
</script>

<div class="dialog-content">
	<div class="app-icon">
		<img src={logo} alt="Atlas" />
	</div>

	<h1 class="app-name">Atlas</h1>

	<p>Version {version} ({commitHash})</p>
	<p>{buildType}</p>
</div>

<style>
	.dialog-content {
		background-color: Canvas;
		color: CanvasText;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		block-size: 100vh;
		inline-size: 100vw;

		position: relative;
		text-align: center;
	}

	.app-icon {
		background: black;
		border-radius: var(--radius-4);
		block-size: var(--size-10);
		inline-size: var(--size-10);
		display: flex;
		align-items: center;
		justify-content: center;
		margin-block-end: var(--size-2);

		img {
			block-size: var(--size-6);
			inline-size: auto;
		}
	}

	.app-name {
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-7);
		margin: 0;
	}

	p {
		font-size: var(--font-size-2);
		margin: 0;
	}
</style>
