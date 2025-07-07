import { defaultTheme, extendTheme, ThemeProvider } from "@inkjs/ui";
import { render } from "ink";
import React from "react";
import { AppProvider } from "../contexts/app-context.tsx";
import { InteractiveCommandInner } from "../modules/conversation/index.ts";
import { YargsInstance } from "../utils/yargs.ts";

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue(
      "The interactive interface provides a user-friendly way to manage workspaces",
    );
}

// Custom theme with yellow highlights for Select components
const customTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: "yellow" }),
        label: ({ isFocused, isSelected }) => ({
          color: isSelected ? "yellow" : isFocused ? "yellow" : undefined,
        }),
      },
    },
  },
});

export function handler() {
  render(
    <ThemeProvider theme={customTheme}>
      <InteractiveCommand />
    </ThemeProvider>,
  );
}

export default function InteractiveCommand() {
  return (
    <AppProvider>
      <InteractiveCommandInner />
    </AppProvider>
  );
}
