import { createToaster } from "@melt-ui/svelte";

export type ToastData = {
  title: string;
  description?: string;
  error?: boolean;
  viewLabel?: string;
  viewAction?: () => unknown;
};

export const toaster = createToaster<ToastData>({ closeDelay: 4000 });
