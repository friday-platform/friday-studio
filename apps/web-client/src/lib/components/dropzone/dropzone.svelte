<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  accept: string[];
  maxSize: number;
  onDrop: (file: File) => void;
  children?: Snippet;
  showHighlight?: boolean;
  name?: string;
  id?: string;
  required?: boolean;
  label?: string;
};

const {
  accept,
  onDrop,
  maxSize,
  children,
  showHighlight = true,
  name,
  id,
  required,
  label = "File Upload",
}: Props = $props();
let isDraggingOver = $state(false);

function validateFile(file: File) {
  // Verify the file size is below the maximum.
  if (file.size > maxSize) {
    return "invalid_size";
  }

  // Verify that the MIME type is allowed.
  const isValidType = accept.some((mimeType) => {
    switch (mimeType) {
      case "*":
        return true;
      case "image/*":
        return file.type.startsWith("image/");
      case "text/*":
        return file.type.startsWith("text/");
      default:
        return file.type === mimeType;
    }
  });

  if (!isValidType) {
    return "invalid_type";
  }

  return "valid";
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();

  isDraggingOver = false;

  if (!e.dataTransfer?.items) {
    return;
  }
  const file = Array.from(e.dataTransfer.files)[0];
  if (file) {
    const validation = validateFile(file);

    if (validation === "invalid_size") {
      alert("Please upload an file smaller than 20MB");
    } else if (validation === "invalid_type") {
      alert("Invalid file type");
    } else {
      onDrop(file);
    }
  }
}

function handleChange(e: Event) {
  const target = e?.target as HTMLInputElement;

  if (!target.files) {
    return;
  }

  const file = target.files[0];

  if (!file) {
    alert("Unable to upload file");
  }

  const validation = validateFile(file);

  if (validation === "invalid_size") {
    alert("Please upload an image smaller than 20MB");
    target.value = "";
  } else if (validation === "invalid_type") {
    alert("Only png, jpg, and svg images are supported");
    target.value = "";
  } else {
    onDrop(file);
  }
}
</script>

<figure class={isDraggingOver ? 'dragging' : ''} class:showHighlight>
	<span class="preview">
		{#if children}
			{@render children()}
		{/if}
	</span>
	<input
		aria-label={label}
		onchange={handleChange}
		ondragover={() => {
			if (!isDraggingOver) {
				isDraggingOver = true;
			}
		}}
		ondragleave={() => {
			isDraggingOver = false;
		}}
		ondrop={handleDrop}
		accept={accept.join(',')}
		type="file"
		{id}
		{name}
		{required}
	/>
</figure>

<style>
	figure {
		border-radius: var(--radius-1);
		display: flex;
		align-items: center;
		justify-content: center;
		inset: 0;
		position: absolute;
		transition: all 150ms ease;

		&.dragging,
		&.showHighlight:hover,
		&.showHighlight:has(input:focus) {
			background-color: var(--highlight-2);
		}
	}

	input {
		inset: 0;
		opacity: 0.01;
		position: absolute;
		z-index: var(--layer-1);
	}
</style>
