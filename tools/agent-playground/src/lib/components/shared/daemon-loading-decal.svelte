<script lang="ts">
  import Message from "./daemon-loading-message.svelte";
</script>

<div class="loading">
  <div class="stage" aria-hidden="true">
    <div class="floor-shadow"></div>
    <div class="strip">
      <div class="r1">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="12" cy="13" r="11.5" fill="none" stroke="#F86604" stroke-width="1.2" />
          </svg>
        </div>
      </div>
      <div class="r2">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="21.75" cy="13" r="11.5" fill="none" stroke="#FF910A" stroke-width="1.2" />
          </svg>
        </div>
      </div>
      <div class="r3">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="30" cy="13" r="11.5" fill="none" stroke="#FFB60C" stroke-width="1.2" />
          </svg>
        </div>
      </div>
      <div class="r4">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="35.25" cy="13" r="11.5" fill="none" stroke="#A25C00" stroke-width="1.2" />
          </svg>
        </div>
      </div>
      <div class="r5">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="40.5" cy="13" r="11.5" fill="none" stroke="#8C42D1" stroke-width="1.2" />
          </svg>
        </div>
      </div>
      <div class="r6">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="48.75" cy="13" r="11.5" fill="none" stroke="#52C218" stroke-width="1.2" />
          </svg>
        </div>
      </div>
      <div class="r7">
        <div class="bob">
          <svg
            class="ring"
            viewBox="0 0 71 25"
            xmlns="http://www.w3.org/2000/svg"
            shape-rendering="geometricPrecision"
          >
            <circle cx="58.5" cy="13" r="11.5" fill="none" stroke="#0476F8" stroke-width="1.2" />
          </svg>
        </div>
      </div>
    </div>
  </div>
  <Message />
</div>

<style>
  /* Tunables — values pulled from the HTML control panel (size overridden
     to 120px). Edit these to retune. */
  .loading {
    --size: 120px;
    --tilt: 4deg;
    --speed: 5.7s;
    --wave: 0.5s;
    --wave-amp: 20px;
    --persp: 1000px;

    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-5);
    justify-content: center;
    padding: var(--size-10);
  }

  .stage {
    display: grid;
    perspective: var(--persp);
    perspective-origin: 50% 55%;
    place-items: center;
    position: relative;
  }

  .floor-shadow {
    background: radial-gradient(
      ellipse,
      rgba(0, 0, 0, 0.55) 0%,
      rgba(0, 0, 0, 0.3) 30%,
      transparent 70%
    );
    block-size: calc(var(--size) * 0.1);
    filter: blur(calc(var(--size) * 0.07));
    inline-size: calc(var(--size) * 1.05);
    inset-block-end: 26%;
    inset-inline-start: 50%;
    pointer-events: none;
    position: absolute;
    transform: translateX(-50%);
    z-index: 0;
  }

  .stage::before {
    background:
      radial-gradient(ellipse at 17% 50%, rgba(248, 102, 4, 0.55), transparent 20%),
      radial-gradient(ellipse at 31% 50%, rgba(255, 145, 10, 0.55), transparent 18%),
      radial-gradient(ellipse at 42% 50%, rgba(255, 182, 12, 0.55), transparent 17%),
      radial-gradient(ellipse at 50% 50%, rgba(162, 92, 0, 0.4), transparent 16%),
      radial-gradient(ellipse at 57% 50%, rgba(140, 66, 209, 0.55), transparent 17%),
      radial-gradient(ellipse at 69% 50%, rgba(82, 194, 24, 0.55), transparent 18%),
      radial-gradient(ellipse at 82% 50%, rgba(4, 118, 248, 0.55), transparent 20%);
    block-size: calc(var(--size) * 0.16);
    border-radius: 50%;
    content: "";
    filter: blur(calc(var(--size) * 0.06));
    inline-size: calc(var(--size) * 0.96);
    inset-block-end: 30%;
    inset-inline-start: 50%;
    opacity: 0.85;
    pointer-events: none;
    position: absolute;
    transform: translateX(-50%);
    z-index: 1;
    animation: pulse calc(var(--speed) * 2) ease-in-out infinite;
  }

  .strip {
    aspect-ratio: 71 / 25;
    inline-size: var(--size);
    position: relative;
    transform-style: preserve-3d;
    z-index: 2;
    animation: rock calc(var(--speed) * 3.2) ease-in-out infinite;
  }

  .strip > div {
    inset: 0;
    position: absolute;
    transform-style: preserve-3d;
  }

  .bob {
    inset: 0;
    position: absolute;
    transform-style: preserve-3d;
    will-change: transform, filter;
    animation: wave-bob var(--speed) ease-in-out infinite;
    filter: drop-shadow(
      0 calc(var(--size) * 0.018) calc(var(--size) * 0.04) rgba(0, 0, 0, 0.45)
    );
  }

  .ring {
    backface-visibility: visible;
    block-size: 100%;
    display: block;
    inline-size: 100%;
    shape-rendering: geometricPrecision;
    transform: translateZ(0);
    transform-style: preserve-3d;
    will-change: transform, filter;
    animation:
      flip var(--speed) linear infinite,
      edgeglow var(--speed) ease-in-out infinite;
  }

  .r1 .ring {
    transform-origin: 16.9% 50%;
  }
  .r2 .ring {
    transform-origin: 30.63% 50%;
  }
  .r3 .ring {
    transform-origin: 42.25% 50%;
  }
  .r4 .ring {
    transform-origin: 49.65% 50%;
  }
  .r5 .ring {
    transform-origin: 57.04% 50%;
  }
  .r6 .ring {
    transform-origin: 68.66% 50%;
  }
  .r7 .ring {
    transform-origin: 82.39% 50%;
  }

  .r1 .bob {
    animation-delay: calc(var(--wave) * 0);
  }
  .r2 .bob {
    animation-delay: calc(var(--wave) * 1);
  }
  .r3 .bob {
    animation-delay: calc(var(--wave) * 2);
  }
  .r4 .bob {
    animation-delay: calc(var(--wave) * 3);
  }
  .r5 .bob {
    animation-delay: calc(var(--wave) * 4);
  }
  .r6 .bob {
    animation-delay: calc(var(--wave) * 5);
  }
  .r7 .bob {
    animation-delay: calc(var(--wave) * 6);
  }

  .r1 .ring {
    animation-delay: calc(var(--wave) * 0), calc(var(--wave) * 0);
  }
  .r2 .ring {
    animation-delay: calc(var(--wave) * 1), calc(var(--wave) * 1);
  }
  .r3 .ring {
    animation-delay: calc(var(--wave) * 2), calc(var(--wave) * 2);
  }
  .r4 .ring {
    animation-delay: calc(var(--wave) * 3), calc(var(--wave) * 3);
  }
  .r5 .ring {
    animation-delay: calc(var(--wave) * 4), calc(var(--wave) * 4);
  }
  .r6 .ring {
    animation-delay: calc(var(--wave) * 5), calc(var(--wave) * 5);
  }
  .r7 .ring {
    animation-delay: calc(var(--wave) * 6), calc(var(--wave) * 6);
  }

  @keyframes wave-bob {
    0%,
    100% {
      transform: translateY(calc(var(--wave-amp) * -1));
    }
    25% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(var(--wave-amp));
    }
    75% {
      transform: translateY(0);
    }
  }

  @keyframes flip {
    from {
      transform: rotateX(var(--tilt)) rotateY(0deg);
    }
    to {
      transform: rotateX(var(--tilt)) rotateY(360deg);
    }
  }

  @keyframes edgeglow {
    0%,
    50%,
    100% {
      filter: brightness(1);
    }
    25%,
    75% {
      filter: brightness(1.5) drop-shadow(0 0 5px rgba(255, 246, 224, 0.5));
    }
  }

  @keyframes rock {
    0%,
    100% {
      transform: rotateZ(-1deg) translateY(0);
    }
    50% {
      transform: rotateZ(1deg) translateY(-2px);
    }
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.7;
      transform: translateX(-50%) scale(1);
    }
    50% {
      opacity: 0.95;
      transform: translateX(-50%) scale(1.06);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .strip,
    .bob,
    .ring,
    .stage::before {
      animation: none;
    }
  }
</style>
