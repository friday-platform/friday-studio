// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  /** Sentry environment: "local", "sandbox", or "production" */
  const __SENTRY_ENVIRONMENT__: string;

  /** Sentry release identifier for deployment tracking */
  const __SENTRY_RELEASE__: string;
}

export {};
