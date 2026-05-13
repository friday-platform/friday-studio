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
  /* Fade in on mount — avoids a hard flash when the daemon connects fast.
     Page-fill / vertical centering is handled by the parent (daemon-gate)
     so this stays a self-contained block of content. */
  .loading {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    justify-content: center;
    padding: var(--size-10);
    animation: fade-in 1s ease-out;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .conveyor {
    block-size: 84px;
    inline-size: 83px;
    overflow: visible;
    position: relative;
  }

  /* Track scrolls left at exactly the rate the walkers leap right, so the
     pair stays locked in place on screen. */
  .track {
    inset: 0;
    position: absolute;
    animation: scroll 1.7s linear infinite;
  }

  @keyframes scroll {
    to {
      transform: translateX(-60px);
    }
  }

  /* D (walker-a) is smaller than the rect (walker-b) to match the real
     Friday F-mark proportions (~0.8x). Both share the same baseline. */
  .walker {
    inset-block-end: 22%;
    position: absolute;
  }

  .walker-a {
    block-size: 18px;
    inline-size: 18px;
    inset-inline-start: 14px;
    animation: hop-a 1.7s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }

  .walker-b {
    block-size: 23px;
    inline-size: 23px;
    inset-inline-start: 41px;
    animation: hop-b 1.7s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }

  .walker svg {
    block-size: 100%;
    display: block;
    fill: #1171df;
    inline-size: 100%;
    transform-box: fill-box;
    transform-origin: 50% 100%;
  }

  /* Leap distance 60px (= 2 × center-to-center spacing of 30px) so the arc
     peak lands directly above the other shape's center. Walker A leaps in
     the first half of the cycle, B in the second half. */
  @keyframes hop-a {
    0% {
      transform: translate(0, 0) scaleY(1);
    }
    5% {
      transform: translate(0, 0) scaleY(0.85);
    }
    14% {
      transform: translate(10px, -17px) scaleY(1.08);
    }
    25% {
      transform: translate(30px, -32px) scaleY(1.05);
    }
    38% {
      transform: translate(51px, -15px) scaleY(0.95);
    }
    47% {
      transform: translate(60px, 0) scaleY(0.6);
    }
    50% {
      transform: translate(60px, -3px) scaleY(1.08);
    }
    54% {
      transform: translate(60px, 0) scaleY(1);
    }
    100% {
      transform: translate(60px, 0) scaleY(1);
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
    64% {
      transform: translate(10px, -17px) scaleY(1.1);
    }
    75% {
      transform: translate(30px, -32px) scaleY(1.05);
    }
    88% {
      transform: translate(51px, -15px) scaleY(0.93);
    }
    97% {
      transform: translate(60px, 0) scaleY(0.55);
    }
    99% {
      transform: translate(60px, -4px) scaleY(1.1);
    }
    100% {
      transform: translate(60px, 0) scaleY(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .walker,
    .track {
      animation: none;
    }
  }
</style>
