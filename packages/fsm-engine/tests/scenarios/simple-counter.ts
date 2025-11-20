import type { FSMDefinition } from "../../types.ts";

export const simpleCounterFSM: FSMDefinition = {
  id: "simple-counter",
  initial: "counting",
  states: {
    counting: {
      documents: [{ id: "counter", type: "counter", data: { value: 0 } }],
      on: {
        INCREMENT: {
          target: "counting",
          actions: [{ type: "code", function: "incrementCounter" }],
        },
      },
    },
  },
  functions: {
    incrementCounter: {
      type: "action",
      code: `
        export default (context, event, updateDoc) => {
          const counter = context.documents.find(d => d.id === 'counter');
          if (counter) {
            const currentValue = counter.data.value || 0;
            updateDoc('counter', { value: currentValue + 1 });
          }
        }
      `,
    },
  },
  documentTypes: {
    counter: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  },
};
