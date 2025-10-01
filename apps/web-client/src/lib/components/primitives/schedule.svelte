<script lang="ts">
import { type CalendarSchedule, CalendarScheduleSchema } from "@atlas/core/artifacts";

type Event = {
  name: string;
  date: Date;
  hourStart: number;
  hourEnd: number;
  duration: string;
  link?: string;
};

let { events, source, sourceUrl }: CalendarSchedule = $props();

let currentTime = $state(new Date());
let interval = $state<NodeJS.Timeout | null>(null);

$effect(() => {
  interval = setInterval(() => {
    currentTime = new Date();
  }, 1000);

  return () => {
    if (interval) {
      clearInterval(interval);
    }
  };
});

function getMeridiem(time: number) {
  return time > 11 ? "pm" : "am";
}

const EventsSchema = CalendarScheduleSchema.shape.events;

let eventsContainer: HTMLDivElement | null = $state(null);

let parsedEvents: Map<number, Event> = $derived.by(() => {
  const eventsMap = new Map<number, Event>();
  events
    ?.filter((event) => EventsSchema.safeParse(event))
    .forEach((event, index) => {
      const start = new Date(event.startDate);
      const end = new Date(event.endDate);

      eventsMap.set(index, {
        name: event.eventName,
        link: event?.link,
        date: start,
        hourStart: start.getHours() + start.getMinutes() / 60,
        hourEnd: end.getHours() + end.getMinutes() / 60,
        duration:
          `${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric" })} - ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric" })}`
            .replaceAll("AM", "am")
            .replaceAll("PM", "pm")
            .replaceAll(" ", ""),
      });
    });

  return eventsMap;
});

const startTime = $derived(
  Array.from(parsedEvents.values()).reduce(
    (min, event) => Math.min(min, Math.floor(event.hourStart)),
    Infinity,
  ),
);

const endTime = $derived(
  Array.from(parsedEvents.values()).reduce(
    (max, event) => Math.max(max, Math.ceil(event.hourEnd), 0),
    0,
  ),
);

const blocks = $derived(endTime - startTime);

const largestColumn = $derived.by(() => {
  if (!eventsContainer) return 1;

  const styles = window.getComputedStyle(eventsContainer);
  const columns = styles.getPropertyValue("grid-template-columns");

  return columns.split(" ").length;
});

// we don't have unique ids, so we created a map to ensure the order is always accurate
function hasConflictingEvents(id: number, start: number, end: number) {
  const otherEvents = new Map(parsedEvents);
  otherEvents.delete(id);

  return Array.from(otherEvents.values()).some(
    (event) =>
      (event.hourStart <= start && event.hourEnd > start) ||
      (event.hourStart < end && event.hourStart >= start),
  );
}
</script>

{#snippet hour(time: number)}
	<div class="hour">
		<span class="time">
			{#if time === 12}
				12
			{:else if time === 24}
				12
			{:else}
				{time > 12 ? time - 12 : time}
			{/if}
			<span class="meridiem">{getMeridiem(time)}</span>
		</span>
	</div>
{/snippet}

{#snippet event(item: [number, Event])}
	{@const conflicts = hasConflictingEvents(item[0], item[1].hourStart, item[1].hourEnd)}

	<article
		class="event"
		class:small={item[1].hourEnd - item[1].hourStart < 0.5}
		class:large={item[1].hourEnd - item[1].hourStart > 0.75}
		style:grid-column={conflicts ? 'auto' : '1 / span ' + largestColumn}
		style:--grid-row-start={(item[1].hourStart - startTime) * 4 + 1}
		style:--grid-row-end={(item[1].hourEnd - startTime) * 4 + 1}
	>
		<svelte:element this={item[1].link ? 'a' : 'div'} href={item[1].link} target="_blank">
			<h2>{item[1].name}</h2>
			<time>{item[1].duration}</time>
		</svelte:element>
	</article>
{/snippet}

{#if parsedEvents.size > 0}
	<div class="component">
		<header>
			{#if parsedEvents && parsedEvents.size > 0}
				{@const dateObj = new Date(Array.from(parsedEvents.values())[0].date)}
				<h2>{dateObj.toLocaleDateString(undefined, { weekday: 'long' })}</h2>
				<time>{dateObj.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</time>
			{/if}

			{#if source}
				<svelte:element this={sourceUrl ? 'a' : 'span'} href={sourceUrl} target="_blank"
					>{source}</svelte:element
				>
			{/if}
		</header>

		<div class="schedule" style:--block-count={blocks * 4}>
			<div class="hours">
				{#each Array.from({ length: blocks }, (_, i) => i + startTime) as time}
					{@render hour(time)}
				{/each}
			</div>

			<div class="events" bind:this={eventsContainer}>
				{#each parsedEvents as item}
					{@render event(item)}
				{/each}
			</div>

			{#if currentTime.getHours() + currentTime.getMinutes() / 60 - startTime > 0 && endTime > currentTime.getHours() + currentTime.getMinutes() / 60}
				<div
					class="current-time"
					style:--position={currentTime.getHours() + currentTime.getMinutes() / 60 - startTime}
				>
					<time>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
						>
							<path
								d="M-5.1656e-07 8L3.76001 5.64999C5.60579 4.49638 8 5.82337 8 8C8 10.1766 5.60579 11.5036 3.76001 10.35L-5.1656e-07 8Z"
								fill="currentColor"
							/>
						</svg>

						{currentTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: 'numeric' })}
					</time>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.component {
		/* Component level css variables */
		--border-color: color-mix(in oklch, var(--color-purple), white 90%);
		max-inline-size: var(--size-96);
	}

	header {
		display: grid;
		grid-template-columns: 1fr max-content;
		grid-template-rows: auto auto;
		border-block-end: var(--size-px) solid var(--border-color);
		padding-block-end: var(--size-2);

		h2 {
			grid-row: 1;
			grid-column: 1 / -1;
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
		}

		time {
			grid-column: 1;
			grid-row: 2;
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-4-5);
			opacity: 0.5;
		}

		a,
		span {
			font-size: var(--font-size-0);
			font-weight: var(--font-weight-4-5);
			grid-row: 2;
			grid-column: 2;
			opacity: 0.5;
			transition: opacity 0.2s ease-in-out;
		}

		a {
			text-underline-offset: var(--size-0-5);
			text-decoration-line: underline;

			&:hover {
				opacity: 1;
			}
		}
	}

	.schedule {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: repeat(var(--block-count, 1), var(--size-3));
		position: relative;

		.current-time {
			block-size: var(--size-4);
			position: absolute;
			inset-block-start: calc(var(--position) * var(--size-12));
			inset-inline: 0;
			transform: translateY(-50%);
			z-index: var(--layer-2);

			&::before {
				block-size: var(--size-px);
				border-block-end: var(--size-px) dotted var(--color-red);
				content: '';
				inset-block-start: 50%;
				inset-inline: 0;
				position: absolute;
			}

			time {
				display: flex;
				block-size: var(--size-4);
				align-items: center;
				gap: var(--size-1);
				color: var(--color-red);
				position: absolute;
				inset-block-start: 0;
				inset-inline-start: 100%;
				font-size: var(--font-size-00);
				font-weight: var(--font-weight-5);
				inline-size: max-content;
				white-space: nowrap;

				svg {
					margin-block-start: var(--size-px);
				}
			}
		}

		.hours,
		.events {
			display: grid;
			grid-column: 1 / -1;
			grid-row: 1 / -1;
		}

		.hours {
			grid-template-rows: subgrid;
		}

		.events {
			grid-template-rows: subgrid;
			padding-inline-start: var(--size-14);
			z-index: var(--layer-2);
		}
	}

	.hour {
		border-block-end: var(--size-px) solid var(--border-color);
		grid-row: span 4;
		padding-block: var(--size-2);
		position: relative;

		.time {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);

			.meridiem {
				font-size: var(--font-size-0);
				font-weight: var(--font-weight-4-5);
				opacity: 0.8;
			}
		}
	}

	.event {
		grid-row: var(--grid-row-start) / var(--grid-row-end);
		padding: var(--size-0-5);

		div,
		a {
			align-items: baseline;
			block-size: 100%;
			background: var(--border-color);
			border-radius: var(--radius-2);
			display: flex;
			gap: var(--size-1);
			padding-block-start: var(--size-1);
			padding-inline: var(--size-2);
		}

		&.small {
			padding-block: var(--size-px);

			div {
				align-items: start;
				padding-block: 0;
			}
		}

		&.large {
			div {
				flex-direction: column;
				padding-block-start: var(--size-2);
			}
		}

		h2 {
			color: var(--color-purple);
			font-size: var(--font-size-0);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		time {
			font-size: var(--font-size-0);
			font-weight: var(--font-weight-4-5);
			line-height: var(--font-lineheight-0);
			opacity: 0.5;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	}
</style>
