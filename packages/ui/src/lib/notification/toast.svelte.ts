import { createToaster } from "@melt-ui/svelte";

export type ToastData = {
  title: string;
  description?: string;
  error?: boolean;
  viewLabel?: string;
  viewAction?: () => unknown;
};

export const toaster = createToaster<ToastData>({ closeDelay: 4000 });

/**
 * Show a toast notification. Exported from this plain `.ts` module so every
 * caller shares a single `toaster` instance regardless of whether they go
 * through the `@atlas/ui` barrel or import the notification component
 * directly — Svelte's `<script module>` blocks can yield duplicate module
 * evaluations under Vite HMR, which would otherwise produce a `toast`
 * function pointing at a separate toaster store than `NotificationPortal`.
 */
export function toast(content: ToastData): void {
  toaster.helpers.addToast({ data: content });
}
