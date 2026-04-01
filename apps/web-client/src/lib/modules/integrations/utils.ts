/** Strip the internal "(APP_ID)" suffix from slack-app credential labels for display. */
export function stripSlackAppId(label: string): string {
  return label.replace(/\s*\([A-Z0-9]+\)$/, "");
}
