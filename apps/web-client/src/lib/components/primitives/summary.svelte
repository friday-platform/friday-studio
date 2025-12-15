<script lang="ts">
import type { SlackSummaryData, SummaryData } from "@atlas/core/artifacts";
import Document from "$lib/components/primitives/document.svelte";
import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";

type Props = { data: SummaryData | SlackSummaryData; source?: "slack" };

let { data, source }: Props = $props();
</script>

<Document name={source === 'slack' ? 'Slack Summary' : 'Search Result'}>
	<div class="summary">
		<MarkdownContent content={data} />
	</div>
</Document>

<style>
	.summary {
		padding: var(--size-6);
	}
</style>
