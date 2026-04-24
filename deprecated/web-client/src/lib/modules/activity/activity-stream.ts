import { getAtlasDaemonUrl } from "@atlas/oapi-client";

let count = 0;
let eventSource: EventSource | null = null;
let onChange: ((count: number) => void) | null = null;

export function startActivityStream(): void {
  if (eventSource) return;

  eventSource = new EventSource(`${getAtlasDaemonUrl()}/api/activity/stream`);
  eventSource.onmessage = (event: MessageEvent) => {
    const data: unknown = JSON.parse(event.data);
    if (data && typeof data === "object" && "count" in data && typeof data.count === "number") {
      count = data.count;
      onChange?.(count);
    }
  };
}

export function getActivityUnreadCount(): number {
  return count;
}

export function resetActivityCount(): void {
  count = 0;
  onChange?.(count);
}

export function onActivityCountChange(cb: (count: number) => void): void {
  onChange = cb;
}
