<script lang="ts">
  import CredentialPicker from "$lib/modules/integrations/credential-picker.svelte";
  import type { AvailableCredential } from "$lib/modules/integrations/types";

  type Props = {
    credentials: AvailableCredential[];
    selectedId: string | null;
    onselect: (credentialId: string) => void;
    onAddNew?: () => void;
  };

  let { credentials, selectedId, onselect, onAddNew }: Props = $props();
</script>

<CredentialPicker {credentials} {selectedId} {onselect} {onAddNew} />
