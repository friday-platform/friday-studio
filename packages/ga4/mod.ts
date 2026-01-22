/**
 * GA4 Analytics core utilities for tracking user events.
 * Events are only tracked in production (when __DEV_MODE__ is false).
 *
 * @see https://developers.google.com/analytics/devguides/collection/ga4/events
 */

declare const __DEV_MODE__: boolean;

declare global {
  interface Window {
    gtag: (...args: unknown[]) => void;
  }
}

export { GA4 } from "./events.ts";

export type EventParams = Record<string, string | number | boolean | undefined>;

export interface ErrorDetails {
  type: "javascript_error" | "unhandled_promise_rejection" | "api_error" | "network_error";
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  endpoint?: string;
  status?: number;
  method?: string;
}

/**
 * Track a GA4 event with optional parameters.
 * No-op in development mode.
 */
export function trackEvent(eventName: string, params?: EventParams): void {
  if (__DEV_MODE__ || typeof globalThis.window === "undefined" || !globalThis.window.gtag) {
    return;
  }

  const cleanParams = params
    ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
    : undefined;

  globalThis.window.gtag("event", eventName, cleanParams);
}

/**
 * Track an error event to GA4.
 */
export function trackError(details: ErrorDetails): void {
  if (__DEV_MODE__ || typeof globalThis.window === "undefined" || !globalThis.window.gtag) {
    return;
  }

  const truncatedStack = details.stack?.slice(0, 500);

  globalThis.window.gtag("event", "client_error", {
    error_type: details.type,
    error_message: details.message?.slice(0, 100),
    error_filename: details.filename,
    error_lineno: details.lineno,
    error_colno: details.colno,
    error_stack: truncatedStack,
    error_endpoint: details.endpoint,
    error_status: details.status,
    error_method: details.method,
    page_url: globalThis.window.location.href,
  });
}

/**
 * Track an API error. Call this when an API request fails.
 */
export function trackApiError(
  endpoint: string,
  status: number,
  message: string,
  method: string = "GET",
): void {
  trackError({ type: "api_error", message, endpoint, status, method });
}

/**
 * Track a network error (e.g., failed to fetch).
 */
export function trackNetworkError(endpoint: string, message: string, method: string = "GET"): void {
  trackError({ type: "network_error", message, endpoint, method });
}

/**
 * Initialize global error handlers for tracking client-side errors.
 * Should be called once on app initialization (e.g., in hooks.client.ts).
 */
export function initErrorTracking(): void {
  if (__DEV_MODE__ || typeof globalThis.window === "undefined") {
    return;
  }

  globalThis.addEventListener("error", (event) => {
    trackError({
      type: "javascript_error",
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack,
    });
  });

  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    trackError({
      type: "unhandled_promise_rejection",
      message: reason?.message || String(reason),
      stack: reason?.stack,
    });
  });
}
