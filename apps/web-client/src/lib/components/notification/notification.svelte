<script lang="ts" module>
  import { toaster, type ToastData } from "./toast.svelte";

  const { helpers } = toaster;

  export const toast = (content: ToastData) => helpers.addToast({ data: content });
</script>
