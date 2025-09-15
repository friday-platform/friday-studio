import { useCallback, useEffect, useMemo, useReducer } from "react";
import OptionMap from "./option-map.ts";
import type { Option } from "./types.ts";

type State = {
  optionMap: OptionMap;
  visibleOptionCount: number;
  focusedValue: string | undefined;
  visibleFromIndex: number;
  visibleToIndex: number;
  previousValue: string | undefined;
  value: string | undefined;
};

type Action =
  | { type: "focus-next-option" }
  | { type: "focus-previous-option" }
  | { type: "select-focused-option" }
  | { type: "reset"; state: State };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "focus-next-option": {
      if (!state.focusedValue) {
        const firstOption = state.optionMap.first;
        if (!firstOption) return state;

        return {
          ...state,
          focusedValue: firstOption.value,
          visibleFromIndex: 0,
          visibleToIndex: Math.min(state.visibleOptionCount - 1, state.optionMap.size - 1),
        };
      }

      const currentOption = state.optionMap.get(state.focusedValue);
      const nextOption = currentOption?.next;

      if (!nextOption) return state;

      let { visibleFromIndex, visibleToIndex } = state;

      // New scrolling logic: slide the window down by one item
      const totalOptions = state.optionMap.size;
      const hasMoreItemsThanVisible = totalOptions > state.visibleOptionCount;

      if (hasMoreItemsThanVisible) {
        // Calculate if we can still scroll down (not at the end)
        const maxPossibleFromIndex = totalOptions - state.visibleOptionCount;
        const canScrollDown = visibleFromIndex < maxPossibleFromIndex;

        if (canScrollDown) {
          // Slide the window down by one item
          visibleFromIndex = visibleFromIndex + 1;
          visibleToIndex = visibleFromIndex + state.visibleOptionCount - 1;
        }
        // If we can't scroll, the window stays the same
      }

      return { ...state, focusedValue: nextOption.value, visibleFromIndex, visibleToIndex };
    }

    case "focus-previous-option": {
      if (!state.focusedValue) return state;

      const currentOption = state.optionMap.get(state.focusedValue);
      const previousOption = currentOption?.previous;

      if (!previousOption) return state;

      let { visibleFromIndex, visibleToIndex } = state;

      // New scrolling logic: slide the window up by one item
      const totalOptions = state.optionMap.size;
      const hasMoreItemsThanVisible = totalOptions > state.visibleOptionCount;

      if (hasMoreItemsThanVisible) {
        // Calculate if we can still scroll up (not at the beginning)
        const canScrollUp = visibleFromIndex > 0;

        if (canScrollUp) {
          // Slide the window up by one item
          visibleFromIndex = visibleFromIndex - 1;
          visibleToIndex = visibleFromIndex + state.visibleOptionCount - 1;
        }
        // If we can't scroll, the window stays the same
      }

      return { ...state, focusedValue: previousOption.value, visibleFromIndex, visibleToIndex };
    }

    case "select-focused-option": {
      if (!state.focusedValue) return state;

      return { ...state, previousValue: state.value, value: state.focusedValue };
    }

    case "reset": {
      return action.state;
    }

    default:
      return state;
  }
};

interface UseSelectStateProps {
  visibleOptionCount?: number;
  options: Option[];
  defaultValue?: string;
  onChange?: (value: string) => void;
}

export interface SelectState {
  focusedValue: string | undefined;
  visibleFromIndex: number;
  visibleToIndex: number;
  value: string | undefined;
  visibleOptions: Array<Option & { index: number }>;
  focusNextOption: () => void;
  focusPreviousOption: () => void;
  selectFocusedOption: () => void;
}

const createDefaultState = ({
  visibleOptionCount = 5,
  defaultValue,
  options,
}: Pick<UseSelectStateProps, "visibleOptionCount" | "defaultValue" | "options">): State => {
  const optionMap = new OptionMap(options);
  const firstOption = optionMap.first;

  let focusedValue = defaultValue;
  if (!focusedValue && firstOption) {
    focusedValue = firstOption.value;
  }

  return {
    optionMap,
    visibleOptionCount,
    focusedValue,
    visibleFromIndex: 0,
    visibleToIndex: Math.min(visibleOptionCount - 1, options.length - 1),
    previousValue: undefined,
    value: defaultValue,
  };
};

export const useSelectState = ({
  visibleOptionCount = 5,
  options,
  defaultValue,
  onChange,
}: UseSelectStateProps): SelectState => {
  const [state, dispatch] = useReducer(
    reducer,
    { visibleOptionCount, defaultValue, options },
    createDefaultState,
  );

  // Reset state when options change
  useEffect(() => {
    const newState = createDefaultState({ visibleOptionCount, defaultValue, options });

    dispatch({ type: "reset", state: newState });
  }, [options, visibleOptionCount, defaultValue]);

  // Call onChange when value changes
  useEffect(() => {
    if (state.value !== state.previousValue && state.value && onChange) {
      onChange(state.value);
    }
  }, [state.value, state.previousValue, onChange]);

  const focusNextOption = useCallback(() => {
    dispatch({ type: "focus-next-option" });
  }, []);

  const focusPreviousOption = useCallback(() => {
    dispatch({ type: "focus-previous-option" });
  }, []);

  const selectFocusedOption = useCallback(() => {
    dispatch({ type: "select-focused-option" });
  }, []);

  const visibleOptions = useMemo(() => {
    return Array.from(state.optionMap.values())
      .slice(state.visibleFromIndex, state.visibleToIndex + 1)
      .map((option) => ({ label: option.label, value: option.value, index: option.index }));
  }, [state.optionMap, state.visibleFromIndex, state.visibleToIndex]);

  return {
    focusedValue: state.focusedValue,
    visibleFromIndex: state.visibleFromIndex,
    visibleToIndex: state.visibleToIndex,
    value: state.value,
    visibleOptions,
    focusNextOption,
    focusPreviousOption,
    selectFocusedOption,
  };
};
