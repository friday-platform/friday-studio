<script lang="ts">
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { onDestroy, onMount } from "svelte";
import { toStore, writable } from "svelte/store";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { Dialog } from "$lib/components/dialog";

const appCtx = getAppContext();

let unlisten: (() => void) | undefined;
let isUploading = $state(false);
let workspaceName = $state<string | null>(null);
let workspacePath = $state<string | null>(null);
let showDialog = $state(false);

async function parseWorkspaceName(path: string): Promise<string | null> {
  try {
    const content = await readTextFile(path);

    // Match "name:" with optional leading whitespace (for nested YAML keys)
    const nameMatch = content.match(/^\s*name:\s*(.+)$/m);

    return nameMatch ? nameMatch[1].trim() : null;
  } catch (error) {
    console.error("Failed to parse workspace.yml:", error);
    return null;
  }
}

async function uploadWorkspace() {
  if (!workspacePath) return;

  isUploading = true;

  try {
    const response = await fetch("http://localhost:8080/api/workspaces/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspacePath }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("Failed to add workspace:", error);
      return;
    }

    const data = await response.json();
    const workspaceId = data.id;

    // Refresh the workspaces list in the sidebar
    appCtx.refreshWorkspaces();

    // Navigate to the new workspace
    window.location.href = appCtx.routes.spaces.item(workspaceId);
  } catch (error) {
    console.error("Failed to add workspace:", error);
  } finally {
    isUploading = false;
    workspaceName = null;
    workspacePath = null;
    showDialog = false;
  }
}

onMount(() => {
  async function setupDragDrop() {
    if (__TAURI_BUILD__) {
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type === "drop") {
          for (const path of event.payload.paths) {
            const fileName = path.split("/").pop() || "";

            if (fileName === "workspace.yml") {
              // Extract workspace directory path
              const wsPath = path.substring(0, path.lastIndexOf("/"));
              workspacePath = wsPath;

              // Parse workspace name from the YAML file
              workspaceName = await parseWorkspaceName(path);

              showDialog = true;
            } else {
              appCtx.stagedFiles.add(path, { path, type: getFileType(path) });
            }
          }
        }
      });
    }
  }

  setupDragDrop();
});

onDestroy(() => {
  if (unlisten) {
    unlisten();
  }
});

let open = writable(true);
</script>

<Dialog.Root
	open={toStore(
		() => showDialog,
		(value) => {
			showDialog = value;
		}
	)}
>
	<Dialog.Content>
		<Dialog.Close />

		<header>
			<svg
				width="32"
				height="32"
				viewBox="0 0 32 32"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
			>
				<path
					d="M16.5869 4.46289C17.7569 4.52152 18.8807 4.75623 19.9336 5.1377C23.1475 6.3022 25.6963 8.8522 26.8604 12.0664H26.8613C27.1771 12.9384 27.3909 13.8591 27.4883 14.8145C27.528 15.2039 27.5488 15.5991 27.5488 15.999C27.5488 16.4003 27.5272 16.7967 27.4873 17.1875L27.4883 17.1865C27.3907 18.1419 27.1764 19.0625 26.8604 19.9346L26.8594 19.9355C25.695 23.1472 23.1472 25.694 19.9355 26.8584L19.9336 26.8604C19.0624 27.176 18.1428 27.3897 17.1885 27.4873H17.1895C16.7981 27.5274 16.401 27.5488 15.999 27.5488C15.5984 27.5488 15.2026 27.5281 14.8125 27.4883C13.8578 27.3908 12.9379 27.1769 12.0664 26.8613V26.8604C8.85607 25.6977 6.30804 23.1538 5.1416 19.9453C4.82356 19.0704 4.60777 18.1464 4.50977 17.1875C4.46983 16.7968 4.44922 16.4003 4.44922 15.999C4.44922 15.7989 4.45392 15.6 4.46387 15.4023C4.52343 14.2323 4.75821 13.1084 5.14062 12.0557C6.30534 8.84932 8.84932 6.30534 12.0557 5.14062C13.1105 4.75746 14.2366 4.52189 15.4092 4.46289C15.6045 4.45315 15.8012 4.44922 15.999 4.44922C16.1962 4.44922 16.3922 4.45328 16.5869 4.46289ZM12.5684 21.7861C12.7963 22.9824 13.0906 24.0608 13.4365 24.9834C13.4673 25.0655 13.4999 25.1455 13.5312 25.2246C14.0074 25.3516 14.4977 25.4439 15 25.4961V21.9355C14.1686 21.9128 13.3558 21.863 12.5684 21.7861ZM19.4316 21.7861C18.6442 21.863 17.8313 21.9128 17 21.9355V25.4961C17.5027 25.4437 17.9933 25.3509 18.4697 25.2236C18.501 25.1448 18.5338 25.0652 18.5645 24.9834C18.9104 24.0608 19.2035 22.9823 19.4316 21.7861ZM7.81738 20.9258C8.62182 22.2588 9.74274 23.3788 11.0762 24.1826C10.8433 23.3546 10.6459 22.4599 10.4883 21.5127C9.54083 21.3551 8.64559 21.1587 7.81738 20.9258ZM24.1797 20.9258C23.3526 21.1583 22.4587 21.3543 21.5127 21.5117C21.3552 22.4581 21.1584 23.3522 20.9258 24.1797C22.2573 23.3761 23.3761 22.2573 24.1797 20.9258ZM12.0664 17C12.0938 17.95 12.1589 18.8678 12.2588 19.7422C13.1329 19.8422 14.0503 19.9071 15 19.9346V17H12.0664ZM17 19.9346C17.95 19.907 18.8678 19.8423 19.7422 19.7422C19.8422 18.8677 19.9081 17.95 19.9355 17H17V19.9346ZM6.50098 17C6.5533 17.5023 6.64631 17.9926 6.77344 18.4688C6.85318 18.5004 6.93379 18.5334 7.0166 18.5645C7.93939 18.9105 9.01829 19.2035 10.2148 19.4316C10.138 18.6442 10.0891 17.8313 10.0664 17H6.50098ZM21.9355 17C21.9128 17.8314 21.863 18.6442 21.7861 19.4316C22.9816 19.2036 24.0594 18.9102 24.9814 18.5645C25.064 18.5335 25.1442 18.5003 25.2236 18.4688C25.3508 17.9926 25.4447 17.5024 25.4971 17H21.9355ZM10.2148 12.5684C9.01819 12.7963 7.93945 13.0905 7.0166 13.4365C6.9335 13.4677 6.85247 13.5005 6.77246 13.5322C6.64558 14.008 6.55414 14.4981 6.50195 15H10.0664C10.0891 14.1687 10.138 13.3558 10.2148 12.5684ZM15 12.0664C14.0504 12.0938 13.1329 12.1589 12.2588 12.2588C12.1589 13.1329 12.0939 14.0504 12.0664 15H15V12.0664ZM17 15H19.9355C19.908 14.0503 19.8422 13.1329 19.7422 12.2588C18.8678 12.1588 17.95 12.0939 17 12.0664V15ZM21.7861 12.5684C21.863 13.3558 21.9128 14.1687 21.9355 15H25.4961C25.4439 14.498 25.3515 14.0081 25.2246 13.5322C25.1449 13.5006 25.0643 13.4676 24.9814 13.4365C24.0593 13.0908 22.9817 12.7962 21.7861 12.5684ZM11.0771 7.81445C9.74185 8.61919 8.6193 9.74095 7.81445 11.0762C8.64347 10.8429 9.53974 10.6461 10.4883 10.4883C10.6461 9.53964 10.8438 8.6435 11.0771 7.81445ZM20.9248 7.81641C21.158 8.64518 21.3549 9.54101 21.5127 10.4893C22.4598 10.6469 23.3547 10.8433 24.1826 11.0762C23.3785 9.74236 22.2583 8.6209 20.9248 7.81641ZM15 6.50098C14.498 6.55317 14.008 6.64557 13.5322 6.77246C13.5002 6.85301 13.4679 6.93487 13.4365 7.01855C13.0907 7.94091 12.7963 9.01894 12.5684 10.2148C13.3558 10.138 14.1687 10.0881 15 10.0654V6.50098ZM17 10.0654C17.8313 10.0882 18.6442 10.138 19.4316 10.2148C19.2035 9.01905 18.9103 7.94086 18.5645 7.01855C18.5331 6.93505 18.4997 6.85383 18.4678 6.77344C17.992 6.64643 17.502 6.55327 17 6.50098V10.0654Z"
					fill="#E3AC38"
					style="fill:#E3AC38;fill:color(display-p3 0.8902 0.6745 0.2196);fill-opacity:1;"
				/>
			</svg>
			<Dialog.Title>Add Workspace</Dialog.Title>
			<Dialog.Description>
				<p>Upload and add a workspace for “{workspaceName}”?</p>
			</Dialog.Description>
		</header>

		<footer>
			<Dialog.Button onclick={() => uploadWorkspace()}>Confirm</Dialog.Button>
			<Dialog.Cancel>Cancel</Dialog.Cancel>
		</footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	header {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* gap: var(--size-2); */

		svg {
			margin-block-end: var(--size-4);
		}
	}

	footer {
		align-items: center;
		display: flex;
		flex-direction: column;
		gap: var(--size-1-5);
		inline-size: 100%;
	}
</style>
