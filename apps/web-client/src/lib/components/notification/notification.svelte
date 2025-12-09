<script lang="ts" module>
import { type ToastData, toaster } from "./toast.svelte";

const { helpers } = toaster;

export const toast = (content: ToastData) => helpers.addToast({ data: content });
</script>
