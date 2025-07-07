import { useInput } from "ink";
import { SelectState } from "./use-select-state.ts";

export interface UseSelectProps {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  isDisabled?: boolean;

  /**
   * Select state.
   */
  state: SelectState;
}

export const useSelect = ({ isDisabled = false, state }: UseSelectProps) => {
  useInput(
    (_input, key) => {
      if (key.downArrow) {
        state.focusNextOption();
      }

      if (key.upArrow) {
        state.focusPreviousOption();
      }

      if (key.return) {
        state.selectFocusedOption();
      }
    },
    { isActive: !isDisabled },
  );
};
