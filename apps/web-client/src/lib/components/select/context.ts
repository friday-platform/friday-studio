import { type CreateSelectProps, createSelect, type SelectOption } from "@melt-ui/svelte";
import { getContext as _getContext, setContext } from "svelte";
import type { Writable } from "svelte/store";

const CONTEXT = "__dropdown_menu";
export type Selected<T> = SelectOption<T>;

export function createContext<T>(
  selected?: Writable<Selected<T>>,
  defaultSelected?: Selected<T>,
  onSelectedChange?: (value: Selected<T> | undefined) => void,
  name?: string,
  disabled?: boolean,
  required?: boolean,
  positioning?: CreateSelectProps["positioning"],
) {
  const {
    elements: { trigger, menu, option, label, group, hiddenInput },
    states: { selectedLabel, selected: selectedOption, open },
    helpers: { isSelected },
  } = createSelect<T>({
    disabled,
    defaultSelected,
    selected,
    loop: false,
    forceVisible: true,
    name,
    required,
    onSelectedChange: ({ next }) => {
      if (onSelectedChange) {
        onSelectedChange(next);
      }
      return next;
    },
    positioning: {
      ...(positioning ?? {}),

      sameWidth: false,
      fitViewport: true,
    },
  });

  const ctx = {
    trigger,
    menu,
    option,
    label,
    open,
    selectedLabel,
    isSelected,
    group,
    hiddenInput,
    selectedOption,
  };
  setContext(CONTEXT, ctx);
  return ctx;
}

export function getContext() {
  return _getContext<ReturnType<typeof createContext>>(CONTEXT);
}
