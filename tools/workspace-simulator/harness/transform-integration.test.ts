/**
 * Integration test: transforms flow through compiler → harness.
 *
 * Verifies that transform expressions in source mappings compile to
 * prepare functions that correctly compute derived values at runtime.
 * The full pipeline: WorkspaceBlueprint → buildFSMFromPlan → runFSM.
 *
 * @module
 */

import { buildFSMFromPlan, type WorkspaceBlueprint } from "@atlas/workspace-builder";
import { describe, expect, it } from "vitest";
import { runFSM } from "./run-fsm.ts";

// ---------------------------------------------------------------------------
// Test plan: order-processing with transforms
// ---------------------------------------------------------------------------

/**
 * A 2-step pipeline where the prepare function uses transforms:
 *   1. process-order → produces order data (line items, customer info)
 *   2. send-invoice → consumes transformed values (total, formatted name)
 *
 * The send-invoice step has:
 *   - A transform that sums line item amounts: `value.reduce((sum, i) => sum + i.amount, 0)`
 *   - A cross-document transform that multiplies by a tax rate from another doc
 *   - A plain extraction (customer_email)
 *   - A constant (currency)
 */
function buildTransformPlan(): WorkspaceBlueprint {
  return {
    workspace: {
      name: "order-processor",
      purpose: "Process orders and send invoices with computed totals",
    },
    signals: [
      {
        id: "order-placed",
        name: "Order Placed",
        title: "Process new order",
        signalType: "http",
        description: "Triggered when a new order is placed",
        signalConfig: { provider: "http", config: { path: "/webhook/order" } },
      },
    ],
    agents: [
      {
        id: "order-agent",
        name: "Order Processor",
        description: "Processes order data and produces structured output",
        capabilities: ["order-processing"],
      },
      {
        id: "invoice-agent",
        name: "Invoice Sender",
        description: "Sends invoice with computed totals",
        capabilities: ["email"],
      },
    ],
    jobs: [
      {
        id: "process-and-invoice",
        name: "Process Order and Send Invoice",
        title: "Order Invoice",
        triggerSignalId: "order-placed",
        steps: [
          {
            id: "process-order",
            agentId: "order-agent",
            executionRef: "order-agent",
            description: "Extract and validate order details",
            depends_on: [],
            executionType: "bundled",
          },
          {
            id: "send-invoice",
            agentId: "invoice-agent",
            executionRef: "invoice-agent",
            description: "Send invoice email with computed totals",
            depends_on: ["process-order"],
            executionType: "bundled",
          },
        ],
        documentContracts: [
          {
            producerStepId: "process-order",
            documentId: "order-output",
            documentType: "order",
            schema: {
              type: "object",
              properties: {
                customer_email: { type: "string" },
                customer_name: { type: "string" },
                line_items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      amount: { type: "number" },
                      quantity: { type: "number" },
                    },
                    required: ["name", "amount", "quantity"],
                  },
                },
              },
              required: ["customer_email", "customer_name", "line_items"],
            },
          },
          {
            producerStepId: "send-invoice",
            documentId: "invoice-confirmation",
            documentType: "invoice-result",
            schema: {
              type: "object",
              properties: { sent: { type: "boolean" } },
              required: ["sent"],
            },
          },
        ],
        prepareMappings: [
          {
            consumerStepId: "send-invoice",
            documentId: "order-output",
            documentType: "order",
            sources: [
              // Plain extraction — no transform
              { from: "customer_email", to: "recipient" },
              // Transform: sum line item amounts
              {
                from: "line_items",
                to: "subtotal",
                transform: "value.reduce((sum, i) => sum + i.amount * i.quantity, 0)",
                description: "Compute order subtotal from line items",
              },
              // Transform: count items
              {
                from: "line_items",
                to: "item_count",
                transform: "value.length",
                description: "Count number of line items",
              },
            ],
            constants: [{ key: "currency", value: "USD" }],
          },
        ],
      },
    ],
  };
}

/**
 * Plan with a cross-document transform referencing `docs`.
 *
 * 3-step pipeline:
 *   1. fetch-rates → produces tax rate config
 *   2. process-order → produces order with line items
 *   3. generate-receipt → uses cross-doc transform to compute taxed total
 */
function buildCrossDocTransformPlan(): WorkspaceBlueprint {
  return {
    workspace: {
      name: "receipt-generator",
      purpose: "Generate receipts with tax calculations from multiple sources",
    },
    signals: [
      {
        id: "receipt-requested",
        name: "Receipt Requested",
        title: "Generate receipt",
        signalType: "http",
        description: "Triggered when a receipt is requested",
        signalConfig: { provider: "http", config: { path: "/webhook/receipt" } },
      },
    ],
    agents: [
      {
        id: "rate-agent",
        name: "Rate Fetcher",
        description: "Fetches current tax rates",
        capabilities: ["tax-rates"],
      },
      {
        id: "order-agent",
        name: "Order Processor",
        description: "Processes order data",
        capabilities: ["orders"],
      },
      {
        id: "receipt-agent",
        name: "Receipt Generator",
        description: "Generates receipt with computed totals",
        capabilities: ["receipts"],
      },
    ],
    jobs: [
      {
        id: "generate-receipt",
        name: "Generate Receipt",
        title: "Receipt Generation",
        triggerSignalId: "receipt-requested",
        steps: [
          {
            id: "fetch-rates",
            agentId: "rate-agent",
            executionRef: "rate-agent",
            description: "Fetch current tax rates",
            depends_on: [],
            executionType: "bundled",
          },
          {
            id: "process-order",
            agentId: "order-agent",
            executionRef: "order-agent",
            description: "Process order details",
            depends_on: ["fetch-rates"],
            executionType: "bundled",
          },
          {
            id: "generate-receipt",
            agentId: "receipt-agent",
            executionRef: "receipt-agent",
            description: "Generate receipt with tax calculations",
            depends_on: ["process-order"],
            executionType: "bundled",
          },
        ],
        documentContracts: [
          {
            producerStepId: "fetch-rates",
            documentId: "rate-config",
            documentType: "config",
            schema: {
              type: "object",
              properties: { tax_rate: { type: "number" }, region: { type: "string" } },
              required: ["tax_rate", "region"],
            },
          },
          {
            producerStepId: "process-order",
            documentId: "order-data",
            documentType: "order",
            schema: {
              type: "object",
              properties: { subtotal: { type: "number" }, customer: { type: "string" } },
              required: ["subtotal", "customer"],
            },
          },
          {
            producerStepId: "generate-receipt",
            documentId: "receipt-output",
            documentType: "receipt",
            schema: {
              type: "object",
              properties: { receipt_id: { type: "string" } },
              required: ["receipt_id"],
            },
          },
        ],
        prepareMappings: [
          {
            consumerStepId: "generate-receipt",
            documentId: "order-data",
            documentType: "order",
            sources: [
              // Plain extraction
              { from: "customer", to: "customer_name" },
              // Cross-document transform: subtotal * tax rate from another doc
              {
                from: "subtotal",
                to: "total_with_tax",
                transform: "value + (value * docs['rate-config'].tax_rate)",
                description: "Compute total including tax from rate-config",
              },
            ],
            constants: [],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests: single-document transforms
// ---------------------------------------------------------------------------

describe("transform integration — single document", () => {
  const plan = buildTransformPlan();
  const firstJob = plan.jobs[0];
  if (!firstJob) throw new Error("No jobs in plan");
  const compiled = buildFSMFromPlan(firstJob);

  it("compiles without errors", () => {
    expect(compiled.success).toBe(true);
  });

  it("runs through harness and reaches completed", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "order-placed",
      agentOverrides: {
        "order-output": {
          customer_email: "alice@example.com",
          customer_name: "Alice",
          line_items: [
            { name: "Widget", amount: 10, quantity: 2 },
            { name: "Gadget", amount: 25, quantity: 1 },
          ],
        },
        "invoice-confirmation": { sent: true },
      },
    });

    expect(report.success).toBe(true);
    expect(report.finalState).toBe("completed");
  });

  it("prepare function produces correct transformed values via return value", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "order-placed",
      agentOverrides: {
        "order-output": {
          customer_email: "alice@example.com",
          customer_name: "Alice",
          line_items: [
            { name: "Widget", amount: 10, quantity: 2 },
            { name: "Gadget", amount: 25, quantity: 1 },
          ],
        },
        "invoice-confirmation": { sent: true },
      },
    });

    // The prepare function returns { task, config } which the engine captures
    // as context.input on the agent action trace.
    const invoiceAgentTraces = report.actionTrace.filter(
      (t) => t.actionType === "agent" && t.actionId === "invoice-agent" && t.status === "completed",
    );
    expect(invoiceAgentTraces).toHaveLength(1);

    const trace = invoiceAgentTraces[0];
    if (!trace?.input?.config) throw new Error("Expected trace with input and config");
    expect(trace.input).toBeDefined();
    expect(trace.input).toHaveProperty("task");
    expect(trace.input).toHaveProperty("config");

    const config = trace.input.config;

    // Plain extraction
    expect(config.recipient).toBe("alice@example.com");

    // Transform: sum(amount * quantity) = (10*2) + (25*1) = 45
    expect(config.subtotal).toBe(45);

    // Transform: line_items.length = 2
    expect(config.item_count).toBe(2);

    // Constant
    expect(config.currency).toBe("USD");
  });

  it("all harness assertions pass", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "order-placed",
      agentOverrides: {
        "order-output": {
          customer_email: "alice@example.com",
          customer_name: "Alice",
          line_items: [
            { name: "Widget", amount: 10, quantity: 2 },
            { name: "Gadget", amount: 25, quantity: 1 },
          ],
        },
        "invoice-confirmation": { sent: true },
      },
    });

    for (const assertion of report.assertions) {
      expect(assertion.passed, assertion.detail ?? assertion.check).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: cross-document transforms (referencing `docs`)
// ---------------------------------------------------------------------------

describe("transform integration — cross-document", () => {
  const plan = buildCrossDocTransformPlan();
  const firstJob = plan.jobs[0];
  if (!firstJob) throw new Error("No jobs in plan");
  const compiled = buildFSMFromPlan(firstJob);

  it("compiles without errors", () => {
    expect(compiled.success).toBe(true);
  });

  it("prepare function uses docs object for cross-document computation", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "receipt-requested",
      agentOverrides: {
        "rate-config": { tax_rate: 0.08, region: "US-CO" },
        "order-data": { subtotal: 100, customer: "Bob" },
        "receipt-output": { receipt_id: "rcpt-001" },
      },
    });

    expect(report.success).toBe(true);
    expect(report.finalState).toBe("completed");

    // The prepare function for generate-receipt returns { task, config }
    // which the engine captures as context.input on the agent trace.
    // total_with_tax = subtotal + (subtotal * docs['rate-config'].tax_rate)
    //                = 100 + (100 * 0.08) = 108
    const receiptAgentTraces = report.actionTrace.filter(
      (t) => t.actionType === "agent" && t.actionId === "receipt-agent" && t.status === "completed",
    );
    expect(receiptAgentTraces).toHaveLength(1);

    const trace = receiptAgentTraces[0];
    if (!trace?.input?.config) throw new Error("Expected trace with input and config");
    expect(trace.input).toBeDefined();
    expect(trace.input).toHaveProperty("task");
    expect(trace.input).toHaveProperty("config");

    const config = trace.input.config;

    // Plain extraction
    expect(config.customer_name).toBe("Bob");

    // Cross-document transform: 100 + (100 * 0.08) = 108
    expect(config.total_with_tax).toBe(108);
  });

  it("all harness assertions pass", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "receipt-requested",
      agentOverrides: {
        "rate-config": { tax_rate: 0.08, region: "US-CO" },
        "order-data": { subtotal: 100, customer: "Bob" },
        "receipt-output": { receipt_id: "rcpt-001" },
      },
    });

    for (const assertion of report.assertions) {
      expect(assertion.passed, assertion.detail ?? assertion.check).toBe(true);
    }
  });
});
