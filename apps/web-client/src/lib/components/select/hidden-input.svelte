<script lang="ts">
  import { getContext } from "./context";

  const { hiddenInput } = getContext();
</script>

<input {...$hiddenInput} use:hiddenInput />
