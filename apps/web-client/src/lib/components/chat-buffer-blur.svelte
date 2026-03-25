<div class="background-blur"></div>

<style>
  .background-blur {
    background: linear-gradient(to top, var(--color-surface-1) 75%, transparent);
    block-size: 5.5625rem;
    border-end-start-radius: var(--radius-7);
    inset-block-end: var(--size-1-5);
    inset-inline-start: calc(var(--size-56) + var(--size-14));
    inset-inline-end: calc(var(--size-80) + var(--size-1-5) + var(--size-px) + var(--size-14));
    position: fixed;
    opacity: 1;
    pointer-events: none;
    z-index: var(--layer-1);

    @media (min-width: 1156px) {
      inset-inline-end: calc(var(--size-96) + var(--size-1-5) + var(--size-px) + var(--size-14));
    }

    @media (min-width: 1920px) {
      inset-inline-start: calc(var(--size-72) + var(--size-14));
      inset-inline-end: calc(var(--size-112) + var(--size-1-5) + var(--size-px) + var(--size-14));
    }
  }
</style>
