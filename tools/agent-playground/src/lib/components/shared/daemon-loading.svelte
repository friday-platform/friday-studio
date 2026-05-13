<script lang="ts">
  import Message from "./daemon-loading-message.svelte";
</script>

<div class="loading">
  <div class="conveyor" aria-hidden="true">
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
    block-size: var(--size-20);
    inline-size: 240px;
    overflow: hidden;
    position: relative;
  }

  .walker {
    block-size: var(--size-7);
    inline-size: var(--size-7);
    inset-block-end: 22%;
    inset-inline-start: 0;
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
    animation: traverse 3.4s linear infinite;
  }

  .walker-b {
    animation: traverse 3.4s linear infinite;
    animation-delay: -1.7s;
  }

  @keyframes traverse {
    0% {
      transform: translate(-30px, 0) scaleY(1);
    }
    5% {
      transform: translate(-30px, 0) scaleY(0.8);
    }
    10% {
      transform: translate(-10px, -28px) scaleY(1.08);
    }
    16% {
      transform: translate(20px, -30px) scaleY(1.05);
    }
    22% {
      transform: translate(50px, 0) scaleY(0.62);
    }
    25% {
      transform: translate(50px, -4px) scaleY(1.05);
    }
    28% {
      transform: translate(50px, 0) scaleY(1);
    }
    33% {
      transform: translate(50px, 0) scaleY(0.85);
    }
    38% {
      transform: translate(72px, -34px) scaleY(1.12);
    }
    44% {
      transform: translate(98px, -36px) scaleY(1.06);
    }
    50% {
      transform: translate(125px, 0) scaleY(0.5);
    }
    53% {
      transform: translate(125px, -7px) scaleY(1.1);
    }
    57% {
      transform: translate(125px, -1px) scaleY(0.96);
    }
    60% {
      transform: translate(125px, 0) scaleY(1);
    }
    66% {
      transform: translate(125px, 0) scaleY(0.78);
    }
    71% {
      transform: translate(148px, -26px) scaleY(1.08);
    }
    77% {
      transform: translate(175px, -28px) scaleY(1.04);
    }
    82% {
      transform: translate(200px, 0) scaleY(0.7);
    }
    85% {
      transform: translate(200px, -3px) scaleY(1.04);
    }
    87% {
      transform: translate(200px, 0) scaleY(1);
    }
    93% {
      transform: translate(225px, -22px) scaleY(1.08);
    }
    100% {
      transform: translate(280px, 0) scaleY(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .walker {
      animation: none;
    }
  }
</style>
