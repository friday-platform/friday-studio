import type { FSMDefinition } from "../../types.ts";

export const orderProcessingFSM: FSMDefinition = {
  id: "order-processing",
  initial: "pending",
  states: {
    pending: {
      on: {
        APPROVE: { target: "approved", actions: [{ type: "emit", event: "order.approved" }] },
        REJECT: { target: "rejected" },
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
  },
};
