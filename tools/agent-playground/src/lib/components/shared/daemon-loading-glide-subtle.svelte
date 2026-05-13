<script lang="ts">
  import Message from "./daemon-loading-message.svelte";
  const layers = [0, 1, 2, 3, 4, 5, 6, 7];
</script>

<div class="loading">
  <div class="glider" aria-hidden="true">
    <div class="piece piece-top">
      {#each layers as z (z)}
        <svg
          class="layer"
          style:--z={z}
          viewBox="4.4668 0 13.3418 13.3418"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
          />
        </svg>
      {/each}
    </div>
    <div class="piece piece-bottom">
      {#each layers as z (z)}
        <svg
          class="layer"
          style:--z={z}
          viewBox="0 14.9014 10.6738 10.6738"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375Z"
          />
        </svg>
      {/each}
    </div>
  </div>
  <Message />
</div>

<style>
  .loading {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-5);
    justify-content: center;
    padding: var(--size-10);
  }

  .glider {
    block-size: var(--size-20);
    inline-size: var(--size-16);
    perspective: 600px;
    position: relative;
    transform-style: preserve-3d;
    /* Slow, gentle slide mask. Lower contrast band — subtle, not a sheen. */
    -webkit-mask-image: linear-gradient(
      105deg,
      rgba(0, 0, 0, 1) 0%,
      rgba(0, 0, 0, 0.7) 50%,
      rgba(0, 0, 0, 1) 100%
    );
    mask-image: linear-gradient(
      105deg,
      rgba(0, 0, 0, 1) 0%,
      rgba(0, 0, 0, 0.7) 50%,
      rgba(0, 0, 0, 1) 100%
    );
    -webkit-mask-size: 220% 100%;
    mask-size: 220% 100%;
    animation: sheen 7s linear infinite;
  }

  @keyframes sheen {
    0% {
      -webkit-mask-position: 120% 0;
      mask-position: 120% 0;
    }
    100% {
      -webkit-mask-position: -120% 0;
      mask-position: -120% 0;
    }
  }

  .piece {
    animation: spin 2.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
    position: absolute;
    transform-style: preserve-3d;
  }

  .piece-top {
    block-size: 52%;
    inline-size: 70%;
    inset-block-start: 0;
    inset-inline-end: 0;
  }

  .piece-bottom {
    animation-direction: reverse;
    block-size: 42%;
    inline-size: 56%;
    inset-block-end: 0;
    inset-inline-start: 0;
  }

  /* Sides match the body surface — when the spin passes edge-on, the
     visible slivers blend into either background. */
  .layer {
    block-size: 100%;
    fill: var(--surface);
    inline-size: 100%;
    inset: 0;
    position: absolute;
    transform: translateZ(calc((var(--z) - 3.5) * 1px));
  }

  /* Front and back faces are the darker surface (left-nav bg). Against
     a body-bg card, that shows up as a faint darker silhouette. */
  .layer:first-child,
  .layer:last-child {
    fill: var(--surface-dark);
  }

  @keyframes spin {
    0% {
      transform: rotateY(0);
    }
    100% {
      transform: rotateY(360deg);
    }
  }


  @media (prefers-reduced-motion: reduce) {
    .piece,
    .glider {
      animation: none;
    }
  }
</style>
