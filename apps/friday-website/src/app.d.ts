// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  function gtag(...args: unknown[]): void;

  interface Window {
    dataLayer: Record<string, unknown>[];
  }

  namespace App {
    // interface Error {}
    interface Locals {
      error?: string;
      stack?: string;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
