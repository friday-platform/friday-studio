<script lang="ts">
import { onMount } from "svelte";
import { SvelteMap } from "svelte/reactivity";

const lightColor = "oklch(0.5 0.2 264)";
const darkColor = "oklch(0.7 0.2 264)";

type Particle = { x: number; y: number; opacity: number; size: number; speed?: number };

let last = 0;
let color = $state(lightColor);
let canvas = $state<HTMLCanvasElement | null>(null);
const map = new SvelteMap<number, Particle>();
const size = 300;
const scale = 2;

function getClampedRandom(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function getRandomPosition(lower: number, upper: number) {
  const radians = (getClampedRandom(0, 360) * Math.PI) / 180.0;
  const radius = getClampedRandom(lower, upper);

  return {
    x: Math.floor(radius * Math.sin(radians) + size),
    y: Math.floor(radius * Math.cos(radians) + size),
    opacity: 1.2 - radius / upper,
  };
}

function draw(ctx: CanvasRenderingContext2D) {
  ctx.globalAlpha = 1;

  ctx.beginPath();

  map.forEach(({ x, y, size, opacity }) => {
    ctx.beginPath();

    ctx.arc(x, y, size * scale, 0, 4 * Math.PI);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fill();
  });
}

function computeNewXY(angle: number, radius: number, vector: [number, number]) {
  const radians = (angle * Math.PI * 2) / 360.0;

  return { x: radius * Math.sin(radians) + vector[0], y: radius * Math.cos(radians) + vector[1] };
}

function update(ctx: CanvasRenderingContext2D, now: number) {
  // render 60fps
  if (!last || now - last >= 16) {
    last = now;
    ctx.clearRect(0, 0, size * 2, size * 2);

    map.forEach((particle, key) => {
      const vector2 = [particle.x - size, particle.y - size];
      let radius = Math.sqrt(vector2[0] ** 2 + vector2[1] ** 2) - 0.5;

      if (radius < 5) {
        // size is the canvas size
        radius = size;
      }

      let speed = 0.45 - (radius / size) * 0.45;

      map.set(key, {
        ...particle,
        // calculates the new x,y vector position based on the current angle - 1deg, a new  speed, and a new radius.
        // This creates the pull in effect towards the center
        ...computeNewXY(
          ((Math.atan2(size, 0) - Math.atan2(vector2[1], vector2[0])) * 360) / (Math.PI * 2) -
            1 * speed,
          radius,
          [size, size],
        ),
        opacity: 1.05 - radius / size,
        speed,
      });
    });

    draw(ctx);
  }

  window.requestAnimationFrame((time) => update(ctx, time));
}

function updateColor(event: MediaQueryListEvent) {
  color = event.matches ? darkColor : lightColor;
}

onMount(() => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.style.height = `${size}px`;
  canvas.style.width = `${size}px`;
  canvas.height = size * scale;
  canvas.width = size * scale;

  for (let i = 0; i < 10000; i++) {
    map.set(i, { ...getRandomPosition(5, size), size: getClampedRandom(0, 0.8) });
  }

  window.requestAnimationFrame((time) => {
    update(ctx, time);
  });

  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    color = darkColor;
  }

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateColor);

  return () => {
    window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", updateColor);
  };
});
</script>

<canvas bind:this={canvas}></canvas>
