import { page } from "$app/state";

export function getActivePage(value: string | string[]) {
  if (Array.isArray(value)) {
    return value.some((v) => String(page.route.id).endsWith(v));
  }
  return String(page.url.pathname).endsWith(value);
}

export function getActiveParam(param: string, value: string) {
  return param in page.params && page.params[param] === value;
}
