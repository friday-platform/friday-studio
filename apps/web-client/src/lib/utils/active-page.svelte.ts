import { page } from "$app/state";

export function getActivePage(value: string | string[]) {
  if (Array.isArray(value)) {
    return value.some((v) => String(page.url.pathname).endsWith(v));
  }
  return String(page.url.pathname).endsWith(value);
}
