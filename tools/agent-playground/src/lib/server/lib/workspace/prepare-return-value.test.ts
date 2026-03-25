/**
 * Integration test: prepare-as-return-value end-to-end flow.
 *
 * Verifies the complete pipeline: compile fixture with prepare mappings →
 * run through harness → data flows via return values (context.input) instead
 * of request documents. Covers engine, compiler, and harness integration.
 *
 * @module
 */

import { buildFSMFromPlan, type WorkspaceBlueprint } from "@atlas/workspace-builder";
import { describe, expect, it } from "vitest";
import { runFSM } from "./run-fsm.ts";

// ---------------------------------------------------------------------------
// Fixture: 2-step pipeline with prepare mappings
// ---------------------------------------------------------------------------

/**
 * Minimal plan with a prepare mapping that exercises:
 *   - Plain field extraction (customer_email → recipient)
 *   - Transform expression (line_items → subtotal via reduce)
 *   - Constant injection (currency: "USD")
 *
 * Step 1: process-order → produces order data
 * Step 2: send-invoice → consumes prepared input via return value
 */
function buildPlan(): WorkspaceBlueprint {
  return {
    workspace: { name: "order-processor", purpose: "Process orders and send invoices" },
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
        description: "Processes order data",
        capabilities: ["orders"],
      },
      {
        id: "invoice-agent",
        name: "Invoice Sender",
        description: "Sends invoices",
        capabilities: ["email"],
      },
    ],
    jobs: [
      {
        id: "process-and-invoice",
        name: "Process and Invoice",
        title: "Order Pipeline",
        triggerSignalId: "order-placed",
        steps: [
          {
            id: "process-order",
            agentId: "order-agent",
            executionRef: "order-agent",
            description: "Extract order details",
            depends_on: [],
            executionType: "bundled",
          },
          {
            id: "send-invoice",
            agentId: "invoice-agent",
            executionRef: "invoice-agent",
            description: "Send invoice with totals",
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
              required: ["customer_email", "line_items"],
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
              { from: "customer_email", to: "recipient" },
              {
                from: "line_items",
                to: "subtotal",
                transform: "value.reduce((sum, i) => sum + i.amount * i.quantity, 0)",
                description: "Compute subtotal",
              },
            ],
            constants: [{ key: "currency", value: "USD" }],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Compile once, share across tests
// ---------------------------------------------------------------------------

const plan = buildPlan();
const firstJob = plan.jobs[0];
if (!firstJob) throw new Error("No jobs in plan");
const compiled = buildFSMFromPlan(firstJob);

const agentOverrides = {
  "order-output": {
    customer_email: "alice@example.com",
    line_items: [
      { name: "Widget", amount: 10, quantity: 2 },
      { name: "Gadget", amount: 25, quantity: 1 },
    ],
  },
  "invoice-confirmation": { sent: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prepare-as-return-value — e2e", () => {
  it("compiles without errors", () => {
    expect(compiled.success).toBe(true);
  });

  it("agent action trace includes structured input from prepare return value", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "order-placed",
      agentOverrides,
    });

    // The send-invoice step has a prepare mapping, so the agent trace
    // should include input with task and config from the return value
    const invoiceAgentTraces = report.actionTrace.filter(
      (t) => t.actionType === "agent" && t.actionId === "invoice-agent" && t.status === "completed",
    );
    expect(invoiceAgentTraces).toHaveLength(1);

    const trace = invoiceAgentTraces[0];
    if (!trace?.input?.config) throw new Error("Expected trace with input and config");
    expect(trace.input).toBeDefined();
    expect(trace.input).toHaveProperty("task");
    expect(trace.input).toHaveProperty("config");

    // Verify the config contains the prepared values
    const config = trace.input.config;
    expect(config.recipient).toBe("alice@example.com");
    expect(config.subtotal).toBe(45); // (10*2) + (25*1)
    expect(config.currency).toBe("USD");
  });

  it("no request documents exist in the document store", async () => {
    if (!compiled.success) throw new Error("Compile failed");

    const report = await runFSM({
      fsm: compiled.value.fsm,
      plan,
      triggerSignal: "order-placed",
      agentOverrides,
    });

    // Only contract-defined results should exist, no *-request docs
    const completedResults = report.resultSnapshots.completed;
    expect(completedResults).toBeDefined();
    if (!completedResults) throw new Error("Expected completed results");

    const resultKeys = Object.keys(completedResults);
    expect(resultKeys).toContain("order-output");
    expect(resultKeys).toContain("invoice-confirmation");

    // No request documents — the old createDoc pattern is gone
    const requestKeys = resultKeys.filter((id) => id.endsWith("-request"));
    expect(requestKeys).toEqual([]);
  });
});
