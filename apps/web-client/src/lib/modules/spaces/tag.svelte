<script lang="ts">
type Props = { color?: string };

let { color = "var(--color-text)" }: Props = $props();
</script>

<span class="color" style:color></span>

<style>
	.color {
		align-items: center;
		block-size: var(--size-4);
		display: flex;
		flex: none;
		inline-size: var(--size-4);
		justify-content: center;

		&:before {
			background-color: currentColor;
			border-radius: var(--radius-round);
			block-size: var(--size-2);
			content: '';
			inline-size: var(--size-2);
		}
	}
</style>
