<script lang="ts">
</script>

<div class="blobs">
	<div class="blob gray"></div>
	<div class="blob blue"></div>
	<div class="blob red"></div>
	<div class="blob pink"></div>
	<div class="blob yellow"></div>
</div>

<style>
	.blobs {
		block-size: 100%;
		inline-size: 100%;
		position: absolute;
		inset-inline-end: 0;
		inset-block-start: 0;
		overflow: visible;
		pointer-events: none;
		opacity: 0.1;
		filter: blur(154px);

		@media (min-width: 768px) {
			inset-inline-end: -100px;
			inset-block-start: -50px;
		}
	}

	.blob {
		position: absolute;
		mix-blend-mode: plus-darker;
	}

	.gray {
		background: #cccedb;
		left: 11%;
		top: 19.93%;
		width: 55.26%;
		height: 55.26%;
	}

	.blue {
		background: #265f95;
		left: 66.26%;
		top: 41.69%;
		width: 43.03%;
		height: 43.03%;
	}

	.red {
		background: #bb373a;
		left: 58.44%;
		top: 67.36%;
		width: 37.16%;
		height: 37.16%;
	}

	.pink {
		background: #f3e3eb;
		left: 23.72%;
		top: 51.47%;
		width: 49.39%;
		height: 49.39%;
	}

	.yellow {
		background: #f2e674;
		left: 63.08%;
		top: 4.52%;
		width: 37.16%;
		height: 37.16%;
	}
</style>
