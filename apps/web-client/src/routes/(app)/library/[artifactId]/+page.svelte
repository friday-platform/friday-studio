<script lang="ts">
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import Display from "$lib/modules/artifacts/display.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();
</script>

<Breadcrumbs.Root>
	<Breadcrumbs.Item href="/library">Library</Breadcrumbs.Item>
	<Breadcrumbs.Segment />
	<Breadcrumbs.Title>{data.artifact?.title ?? 'Item'}</Breadcrumbs.Title>
</Breadcrumbs.Root>

<div class="wrapper">
	<div class="container">
		<Display artifactId={data.artifactId} />
	</div>
</div>

<style>
	.wrapper {
		block-size: 100%;
		padding: var(--size-8);
		overflow: auto;
	}
	.container {
		align-items: center;
		min-block-size: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		inline-size: 100%;
	}
</style>
