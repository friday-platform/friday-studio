<script lang="ts">
  import Message from "./daemon-loading-message.svelte";
</script>

<div class="loading">
  <div class="stage" aria-hidden="true">
    <div class="piece piece-rect">
      <svg viewBox="4.4668 0 13.3418 13.3418" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
        />
      </svg>
    </div>
    <div class="piece piece-d">
      <svg viewBox="0 14.9014 10.6738 10.6738" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375Z"
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

  .stage {
    block-size: 100px;
    inline-size: 90px;
    position: relative;
  }

  .piece {
    block-size: 30px;
    inline-size: 30px;
    position: absolute;
  }

  .piece svg {
    block-size: 100%;
    display: block;
    fill: #1171df;
    inline-size: 100%;
  }

  .piece-rect {
    inset-block-start: 15px;
    inset-inline-start: 50px;
    animation: dance-rect 2.6s cubic-bezier(0.4, 0, 0.5, 1) infinite;
  }

  .piece-d {
    inset-block-start: 55px;
    inset-inline-start: 5px;
    animation: dance-d 2.6s cubic-bezier(0.4, 0, 0.5, 1) infinite;
  }

  @keyframes dance-rect {
    0% {
      transform: translate(0, 0) rotate(0) scaleY(1);
    }
    8% {
      transform: translate(0, 0) scaleY(0.95);
    }
    12% {
      transform: translate(-2px, 2px) rotate(8deg);
    }
    25% {
      transform: translate(-18px, 18px) rotate(3deg);
    }
    35% {
      transform: translate(-32px, 32px) rotate(-2deg);
    }
    44% {
      transform: translate(-45px, 40px) rotate(0) scaleY(0.62);
    }
    47% {
      transform: translate(-45px, 37px) scaleY(1.08);
    }
    50% {
      transform: translate(-45px, 40px) scaleY(1);
    }
    55% {
      transform: translate(-45px, 40px) scaleY(0.85);
    }
    62% {
      transform: translate(-35px, 10px) scaleY(1.1);
    }
    73% {
      transform: translate(-22px, -12px) scaleY(1.05);
    }
    85% {
      transform: translate(-8px, 12px) scaleY(0.95);
    }
    93% {
      transform: translate(0, 0) scaleY(0.55);
    }
    96% {
      transform: translate(0, -4px) scaleY(1.08);
    }
    100% {
      transform: translate(0, 0) scaleY(1);
    }
  }

  @keyframes dance-d {
    0% {
      transform: translate(0, 0) rotate(0) scaleY(1);
    }
    5% {
      transform: translate(0, 0) scaleY(0.85);
    }
    13% {
      transform: translate(8px, -18px) scaleY(1.1);
    }
    25% {
      transform: translate(22px, -45px) scaleY(1.05);
    }
    37% {
      transform: translate(38px, -28px) scaleY(0.95);
    }
    44% {
      transform: translate(45px, -40px) scaleY(0.62);
    }
    47% {
      transform: translate(45px, -43px) scaleY(1.08);
    }
    50% {
      transform: translate(45px, -40px) scaleY(1);
    }
    58% {
      transform: translate(45px, -40px) scaleY(0.95);
    }
    62% {
      transform: translate(43px, -38px) rotate(-8deg);
    }
    75% {
      transform: translate(28px, -18px) rotate(-3deg);
    }
    85% {
      transform: translate(13px, 4px) rotate(2deg);
    }
    93% {
      transform: translate(0, 0) rotate(0) scaleY(0.6);
    }
    96% {
      transform: translate(0, -4px) scaleY(1.08);
    }
    100% {
      transform: translate(0, 0) scaleY(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .piece {
      animation: none;
    }
  }
</style>
