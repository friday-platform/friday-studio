<script lang="ts">
	const IMAGE_URL = '.';

	type Props = {
		src: string;
		alt?: string;
		role?: 'presentation' | 'img';
		isPublic?: boolean;
		cover?: boolean;
	};

	let { src, alt, role = 'img', isPublic = false, cover = false }: Props = $props();
</script>

{#if src.includes('base64') || src.includes('https')}
	<img class:cover {role} {src} {alt} />
{:else if !isPublic}
	<img class:cover {role} src="{IMAGE_URL}/image/thumbnail/width/480/image/{src}" {alt} />
{:else}
	<img class:cover {role} src="{IMAGE_URL}/image/public/thumbnail/width/480/image/{src}" {alt} />
{/if}

<style>
	.cover {
		block-size: 100%;
		inline-size: 100%;
		inset: 0;
		object-fit: cover;
		position: absolute;
	}
</style>
