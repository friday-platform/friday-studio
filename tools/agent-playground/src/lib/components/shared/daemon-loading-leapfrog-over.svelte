<script lang="ts">
  import Message from "./daemon-loading-message.svelte";
</script>

<div class="loading">
  <div class="conveyor" aria-hidden="true">
    <div class="track">
      <div class="walker walker-a">
        <svg viewBox="0 14.9014 10.6738 10.6738" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375Z"
          />
        </svg>
      </div>
      <div class="walker walker-b">
        <svg viewBox="4.4668 0 13.3418 13.3418" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
          />
        </svg>
      </div>
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

  .conveyor {
    block-size: var(--size-32);
    inline-size: 160px;
    overflow: visible;
    position: relative;
  }

  .track {
    inset: 0;
    position: absolute;
    animation: scroll 2s linear infinite;
  }

  @keyframes scroll {
    to {
      transform: translateX(-80px);
    }
  }

  .walker {
    block-size: var(--size-7);
    inline-size: var(--size-7);
    inset-block-end: 22%;
    position: absolute;
  }

  .walker svg {
    block-size: 100%;
    display: block;
    fill: #1171df;
    inline-size: 100%;
    transform-box: fill-box;
    transform-origin: 50% 100%;
  }

  .walker-a {
    inset-inline-start: 20px;
    animation: hop-a 2s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }

  .walker-b {
    inset-inline-start: 60px;
    animation: hop-b 2s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }

  @keyframes hop-a {
    0% {
      transform: translate(0, 0) scaleY(1);
    }
    5% {
      transform: translate(0, 0) scaleY(0.85);
    }
    12% {
      transform: translate(10px, -28px) scaleY(1.08);
    }
    25% {
      transform: translate(40px, -52px) scaleY(1.05);
    }
    38% {
      transform: translate(70px, -28px) scaleY(0.95);
    }
    47% {
      transform: translate(80px, 0) scaleY(0.55);
    }
    50% {
      transform: translate(80px, -5px) scaleY(1.08);
    }
    53% {
      transform: translate(80px, -1px) scaleY(0.97);
    }
    56% {
      transform: translate(80px, 0) scaleY(1);
    }
    100% {
      transform: translate(80px, 0) scaleY(1);
    }
  }

  @keyframes hop-b {
    0%,
    50% {
      transform: translate(0, 0) scaleY(1);
    }
    55% {
      transform: translate(0, 0) scaleY(0.85);
    }
    62% {
      transform: translate(10px, -28px) scaleY(1.1);
    }
    75% {
      transform: translate(40px, -52px) scaleY(1.05);
    }
    88% {
      transform: translate(70px, -28px) scaleY(0.93);
    }
    97% {
      transform: translate(80px, 0) scaleY(0.5);
    }
    99% {
      transform: translate(80px, -6px) scaleY(1.1);
    }
    100% {
      transform: translate(80px, 0) scaleY(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .walker,
    .track {
      animation: none;
    }
  }
</style>
