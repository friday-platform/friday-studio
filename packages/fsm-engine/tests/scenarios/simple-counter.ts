import type { FSMDefinition } from "../../types.ts";

export const simpleCounterFSM: FSMDefinition = {
  id: "simple-counter",
  initial: "counting",
  states: {
    counting: { on: { INCREMENT: { target: "counting" }, STOP: { target: "done" } } },
    done: { type: "final" },
  },
};
