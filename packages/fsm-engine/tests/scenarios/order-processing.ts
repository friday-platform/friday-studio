import type { FSMDefinition } from "../../types.ts";

export const orderProcessingFSM: FSMDefinition = {
  id: "order-processing",
  initial: "pending",
  states: {
    pending: {
      on: {
        APPROVE: {
          target: "approved",
          guards: ["checkInventory"],
          actions: [
            { type: "code", function: "updateOrderStatus" },
            { type: "emit", event: "order.approved" },
          ],
        },
        REJECT: { target: "rejected", actions: [{ type: "code", function: "updateOrderStatus" }] },
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
  },
  functions: {
    checkInventory: {
      type: "guard",
      code: `
        export default (context) => {
          const inventory = context.documents.find(d => d.id === 'inventory');
          const order = context.documents.find(d => d.id === 'order');

          if (!inventory || !order) return false;

          const item = order.data.item;
          const stock = inventory.data[item] || 0;
          const qty = order.data.quantity || 1;

          return stock >= qty;
        }
      `,
    },
    updateOrderStatus: {
      type: "action",
      code: `
        export default (context, event) => {
          const status = event.type === 'APPROVE' ? 'approved' : 'rejected';
          context.updateDoc('order', { status });
        }
      `,
    },
  },
  documentTypes: {
    order: {
      type: "object",
      properties: {
        item: { type: "string" },
        quantity: { type: "number" },
        status: { type: "string", enum: ["pending", "approved", "rejected"] },
      },
      required: ["item", "status"],
    },
    inventory: {
      type: "object",
      additionalProperties: true, // Allow any item keys
    },
  },
};
