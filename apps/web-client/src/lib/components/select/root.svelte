<script lang="ts" generics="T extends unknown">
  import type { CreateSelectProps } from "@melt-ui/svelte";
  import type { Snippet } from "svelte";
  import type { Writable } from "svelte/store";
  import { createContext, type Selected } from "./context";

  type Props = {
    children: Snippet;
    defaultSelected?: Selected<T>;
    selected?: Writable<Selected<T>>;
    onSelectedChange?: (value: Selected<T> | undefined) => void;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    positioning?: CreateSelectProps["positioning"];
  };

  let {
    children,
    selected,
    defaultSelected,
    onSelectedChange,
    name,
    disabled,
    required,
    positioning,
  }: Props = $props();

  createContext<T>(
    selected,
    defaultSelected,
    onSelectedChange,
    name,
    disabled,
    required,
    positioning,
  );
</script>

{@render children()}
