import {
  getActivityUnreadCount as _getCount,
  startActivityStream as _start,
  onActivityCountChange,
  resetActivityCount,
} from "./activity-stream.ts";

let count = $state(0);

onActivityCountChange((n) => {
  count = n;
});

export function startActivityStream(): void {
  _start();
}

export function getActivityUnreadCount(): number {
  return count;
}

export { resetActivityCount };
