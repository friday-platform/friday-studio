<script lang="ts">
import { hasContext } from "svelte";
import Button from "$lib/components/button.svelte";
import Dropzone from "$lib/components/dropzone/dropzone.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import SafeImage from "$lib/components/safe-image.svelte";
import { FIELD_CONTEXT, getFieldContext } from "./context";

const MAX_UPLOAD_SIZE = 1024 * 1024 * 10;

type Props = {
  uploadLabel?: string;
  name?: string;
  onChange?: (value: File) => void;
  required?: boolean;
  radius?: "square" | "circle";
  src?: string;
  isPublic?: boolean;
};

let {
  uploadLabel = "Select Image",
  onChange,
  name,
  required,
  radius = "square",
  src = "",
  isPublic = false,
}: Props = $props();

let preview = $state<string>(src);
let id = $state<string>();

if (hasContext(FIELD_CONTEXT)) {
  id = getFieldContext().id;
}
</script>

<div class="photo radius--{radius}">
	{#if preview !== ''}
		<SafeImage src={preview} alt="Preview" {isPublic} />
	{:else}
		<span>
			<CustomIcons.Image />
		</span>
	{/if}

	<div class="button">
		<Button noninteractive size="icon" aria-label={uploadLabel}>
			<CustomIcons.Pencil />
		</Button>
	</div>

	<div class="dropzone">
		<Dropzone
			showHighlight={false}
			maxSize={MAX_UPLOAD_SIZE}
			accept={['image/*']}
			{id}
			{required}
			onDrop={async (file: File) => {
				if (onChange) {
					onChange(file);
				}

				const formData = new FormData();

				formData.set('image', file);

				// This file can't use the `routes` object because it's not available outside the scope of an org.
				const response = await fetch(`/upload-image?public=${isPublic}`, {
					method: 'POST',
					body: formData
				});

				const data: Record<'path', string> = JSON.parse(await response.json());

				preview = data.path;
			}}
		/>
	</div>
</div>

<input type="hidden" {name} value={preview} />

<style>
	.photo {
		align-items: center;
		display: flex;
		flex-direction: column;
		gap: var(--size-3);
		margin: 0 auto;
		position: relative;
		inline-size: fit-content;

		:global(img),
		span {
			border-radius: var(--radius-3);
			display: block;
			aspect-ratio: 1 / 1;
			inline-size: var(--size-18);
			object-fit: cover;
		}

		&.radius--circle {
			:global(img),
			span {
				border-radius: var(--radius-round);
			}
		}

		span {
			align-items: center;
			background-color: var(--highlight-2);
			color: var(--text-3);
			display: flex;
			justify-content: center;
			font-size: var(--font-size-6);
			transition: background-color 125ms ease-out;
		}

		&:focus-within span,
		&:hover span {
			background-color: var(--highlight-3);
		}

		&:focus-within :global(img),
		&:focus-within span {
			box-shadow:
				0 0 0 var(--size-0-5) var(--background-1),
				0 0 0 var(--size-1) var(--highlight-3);
		}

		.button {
			inset-block-end: calc(-1 * var(--size-2));
			inset-inline-end: calc(-1 * var(--size-2));
			position: absolute;
			z-index: 0;
		}

		.dropzone {
			inset: calc(-1 * var(--size-2));
			position: absolute;
		}
	}
</style>
