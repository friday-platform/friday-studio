import { type CalendarSchedule, CalendarScheduleSchema } from "@atlas/core/artifacts";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

type Event = {
  name: string;
  date: Date;
  hourStart: number;
  hourEnd: number;
  duration: string;
  link?: string;
};

const EventsSchema = CalendarScheduleSchema.shape.events;

function event(item: [number, Event]) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>{item[1].name}</Text>
      <Text>{item[1].duration}</Text>
    </Box>
  );
}

export function Schedule({ events, source }: CalendarSchedule) {
  const [parsedEvents, setParsedEvents] = useState<Map<number, Event>>(new Map());
  const [date, setDate] = useState<Date>(new Date());

  useEffect(() => {
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

    setParsedEvents(eventsMap);
  }, [events]);

  useEffect(() => {
    setDate((value) => {
      const firstEvent = Array.from(parsedEvents.values())?.[0];
      if (!firstEvent) return value;

      return new Date(firstEvent.date);
    });
  }, [parsedEvents]);

  if (parsedEvents.size === 0) return null;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" flexShrink={0}>
        <Text>{date.toLocaleDateString(undefined, { weekday: "long" })}</Text>
        <Text>{date.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</Text>

        {source && <Text>{source}</Text>}
      </Box>

      {parsedEvents.entries().map((item) => event(item))}
    </Box>
  );
}
