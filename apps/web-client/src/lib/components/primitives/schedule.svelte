<script lang="ts">
import { type CalendarSchedule, CalendarScheduleSchema } from "@atlas/core/artifacts";

type Event = {
  id: string;
  name: string;
  date: Date;
  endDate: Date;
  hourStart: number;
  hourEnd: number;
  duration: string;
  link?: string;
  isAllDay: boolean;
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

function getDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function roundDownTo15(hour: number): number {
  const hours = Math.floor(hour);
  const minutes = (hour - hours) * 60;
  const roundedMinutes = Math.floor(minutes / 15) * 15;
  return hours + roundedMinutes / 60;
}

function isAllDayEvent(start: Date, end: Date): boolean {
  return (
    start.getHours() === 0 &&
    start.getMinutes() === 0 &&
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getTime() > start.getTime()
  );
}

const EventsSchema = CalendarScheduleSchema.shape.events;

let eventsContainer: HTMLDivElement | null = $state(null);

let parsedEvents: Map<string, Event> = $derived.by(() => {
  const eventsMap = new Map<string, Event>();
  events
    ?.filter((event) => EventsSchema.safeParse(event))
    .forEach((event) => {
      const start = new Date(event.startDate);
      const end = new Date(event.endDate);
      const allDay = isAllDayEvent(start, end);

      eventsMap.set(event.id, {
        id: event.id,
        name: event.eventName,
        link: event?.link,
        date: start,
        endDate: end,
        isAllDay: allDay,
        hourStart: allDay ? 0 : roundDownTo15(start.getHours() + start.getMinutes() / 60),
        hourEnd: allDay ? 0.5 : roundDownTo15(end.getHours() + end.getMinutes() / 60),
        duration: allDay
          ? "All Day"
          : `${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric" })} - ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric" })}`
              .replaceAll("AM", "am")
              .replaceAll("PM", "pm")
              .replaceAll(" ", ""),
      });
    });

  return eventsMap;
});

// Count unique days in events
const uniqueDays = $derived.by(() => {
  const days = new Set<string>();
  for (const event of parsedEvents.values()) {
    days.add(getDateKey(event.date));
  }
  return days.size;
});

// Whether we should show multi-day list view
const isMultiDay = $derived(uniqueDays > 1);

// Sort events by date then time for multi-day view
const sortedEvents = $derived.by(() => {
  const eventsList = Array.from(parsedEvents.values());
  return eventsList.sort((a, b) => {
    // First sort by date
    const dateCompare = a.date.getTime() - b.date.getTime();
    if (dateCompare !== 0) return dateCompare;
    // Then by start time
    return a.hourStart - b.hourStart;
  });
});

// Group events by day for multi-day view
const eventsByDay = $derived.by(() => {
  const grouped = new Map<string, { date: Date; events: Event[] }>();
  for (const event of sortedEvents) {
    const key = getDateKey(event.date);
    if (!grouped.has(key)) {
      grouped.set(key, { date: event.date, events: [] });
    }
    grouped.get(key)!.events.push(event);
  }
  return Array.from(grouped.values());
});

const hasAllDayEvents = $derived(Array.from(parsedEvents.values()).some((event) => event.isAllDay));

const allDayRowOffset = $derived(hasAllDayEvents ? 4 : 0);

const startTime = $derived(
  Array.from(parsedEvents.values())
    .filter((event) => !event.isAllDay)
    .reduce((min, event) => Math.min(min, Math.floor(event.hourStart)), Infinity),
);

const endTime = $derived(
  Array.from(parsedEvents.values())
    .filter((event) => !event.isAllDay)
    .reduce((max, event) => Math.max(max, Math.ceil(event.hourEnd), 0), 0),
);

const blocks = $derived(endTime - startTime);

const largestColumn = $derived.by(() => {
  if (!eventsContainer) return 1;

  const styles = window.getComputedStyle(eventsContainer);
  const columns = styles.getPropertyValue("grid-template-columns");

  return columns.split(" ").length;
});

// we don't have unique ids, so we created a map to ensure the order is always accurate
function hasConflictingEvents(id: string, start: number, end: number) {
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
			{#if time === 12 || time === 0}
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

{#snippet event(item: [string, Event])}
	{@const evt = item[1]}
	{@const conflicts = evt.isAllDay
		? false
		: hasConflictingEvents(item[0], evt.hourStart, evt.hourEnd)}
	{@const gridRowStart = evt.isAllDay ? 1 : (evt.hourStart - startTime) * 4 + 1 + allDayRowOffset}
	{@const gridRowEnd = evt.isAllDay ? 3 : (evt.hourEnd - startTime) * 4 + 1 + allDayRowOffset}

	<article
		class="event"
		class:tiny={evt.hourEnd - evt.hourStart === 0.25}
		class:small={evt.isAllDay || evt.hourEnd - evt.hourStart <= 0.5}
		class:large={evt.hourEnd - evt.hourStart > 0.75}
		style:grid-column={conflicts ? 'auto' : '1 / span ' + largestColumn}
		style:--grid-row-start={gridRowStart}
		style:--grid-row-end={gridRowEnd}
	>
		<svelte:element this={evt.link ? 'a' : 'div'} href={evt.link} target="_blank">
			<h2>{evt.name}</h2>
			<time>{evt.duration}</time>
		</svelte:element>
	</article>
{/snippet}

{#snippet listEvent(evt: Event)}
	<article class="list-event">
		<svelte:element this={evt.link ? 'a' : 'div'} href={evt.link} target="_blank">
			<h3>{evt.name}</h3>
			<time>{evt.duration}</time>
		</svelte:element>
	</article>
{/snippet}

{#if parsedEvents.size > 0}
	<div class="component">
		{#if isMultiDay}
			<!-- Multi-day list view -->
			<header class="multi-day-header">
				<h2>Schedule</h2>
				{#if source}
					<svelte:element this={sourceUrl ? 'a' : 'span'} href={sourceUrl} target="_blank"
						>{source}</svelte:element
					>
				{/if}
			</header>

			<div class="multi-day-list">
				{#each eventsByDay as day (day.date)}
					<div class="day-group">
						<div class="day-header">
							<span class="day-name">
								{day.date.toLocaleDateString(undefined, { weekday: 'long' })}
							</span>
							<span class="day-date">
								{day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
							</span>
						</div>

						<div class="day-events">
							{#each day.events as evt (evt.id)}
								{@render listEvent(evt)}
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Single-day grid view -->
			<header>
				{#if parsedEvents && parsedEvents.size > 0}
					{@const dateObj = new Date(Array.from(parsedEvents.values())[0].date)}
					<h2>{dateObj.toLocaleDateString(undefined, { weekday: 'long' })}</h2>
					<time>{dateObj.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</time>
				{/if}

				{#if source}
					<svelte:element this={sourceUrl ? 'a' : 'span'} href={sourceUrl} target="_blank">
						{source}
					</svelte:element>
				{/if}
			</header>

			<div class="schedule" style:--block-count={blocks * 4 + allDayRowOffset}>
				<div class="hours">
					{#if hasAllDayEvents}
						<div class="hour all-day-hour">
							<span class="time">All Day</span>
						</div>
					{/if}
					{#each Array.from({ length: blocks }, (_, i) => i + startTime) as time (time)}
						{@render hour(time)}
					{/each}
				</div>

				<div class="events" bind:this={eventsContainer}>
					{#each parsedEvents as item, i (i)}
						{@render event(item)}
					{/each}
				</div>

				{#if currentTime.getHours() + currentTime.getMinutes() / 60 - startTime > 0 && endTime > currentTime.getHours() + currentTime.getMinutes() / 60}
					<div
						class="current-time"
						style:--position={currentTime.getHours() + currentTime.getMinutes() / 60 - startTime}
						style:--all-day-offset={hasAllDayEvents ? 1 : 0}
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
		{/if}
	</div>
{/if}

<style>
	.component {
		/* Component level css variables */
		--border-color: color-mix(in oklch, var(--color-purple), var(--color-surface-1) 90%);
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
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
		}

		time {
			grid-column: 1;
			grid-row: 2;
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-4-5);
			opacity: 0.5;
		}

		a,
		span {
			font-size: var(--font-size-1);
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
		grid-template-rows: repeat(var(--block-count, 1), var(--size-3-5));
		position: relative;

		.current-time {
			block-size: var(--size-4);
			position: absolute;
			inset-block-start: calc((var(--position) + var(--all-day-offset, 0)) * var(--size-12));
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
				font-size: var(--font-size-0);
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
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);

			.meridiem {
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4-5);
				opacity: 0.8;
			}
		}
	}

	.event {
		grid-row: var(--grid-row-start) / var(--grid-row-end);
		overflow: hidden;
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

		h2 {
			color: var(--color-purple);
			font-size: var(--font-size-1);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-1);

			@media (prefers-color-scheme: dark) {
				color: color-mix(in oklch, var(--color-purple), var(--color-text) 65%);
			}
		}

		time {
			font-size: var(--font-size-1);
			font-weight: var(--font-weight-4-5);
			line-height: var(--font-lineheight-0);
			opacity: 0.5;
			white-space: nowrap;
		}

		&.tiny {
			h2,
			time {
				font-size: var(--font-size-0);
				white-space: nowrap;
			}
		}

		&.tiny,
		&.small {
			padding-block: var(--size-px);

			div,
			a {
				align-items: center;
				padding-block: 0;
			}

			h2 {
				flex: 1;
				overflow: hidden;
				text-overflow: ellipsis;
			}
		}

		&.large {
			div {
				flex-direction: column;
				padding-block-start: var(--size-2);
			}
		}
	}

	/* Multi-day list view styles */
	.multi-day-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		border-block-end: var(--size-px) solid var(--border-color);
		padding-block-end: var(--size-2);
		margin-block-end: var(--size-3);

		h2 {
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
		}

		a,
		span {
			font-size: var(--font-size-1);
			font-weight: var(--font-weight-4-5);
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

	.multi-day-list {
		display: flex;
		flex-direction: column;
		gap: var(--size-4);
	}

	.day-group {
		display: flex;
		flex-direction: column;
		gap: var(--size-2);
	}

	.day-header {
		display: flex;
		align-items: baseline;
		gap: var(--size-2);
		border-block-end: var(--size-px) solid var(--border-color);
		padding-block-end: var(--size-1);

		.day-name {
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
		}

		.day-date {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-4-5);
			opacity: 0.5;
		}
	}

	.day-events {
		display: flex;
		flex-direction: column;
		gap: var(--size-1);
	}

	.list-event {
		div,
		a {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: var(--size-2);
			background: var(--border-color);
			border-radius: var(--radius-2);
			padding-block: var(--size-2);
			padding-inline: var(--size-3);
		}

		a {
			text-decoration: none;
			transition: opacity 0.2s ease-in-out;

			&:hover {
				opacity: 0.8;
			}
		}

		h3 {
			color: var(--color-purple);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);

			@media (prefers-color-scheme: dark) {
				color: color-mix(in oklch, var(--color-purple), var(--color-text) 65%);
			}
		}

		time {
			flex: none;
			font-size: var(--font-size-1);
			font-weight: var(--font-weight-4-5);
			line-height: var(--font-lineheight-0);
			opacity: 0.5;
			inline-size: max-content;
			text-align: end;
		}
	}
</style>
