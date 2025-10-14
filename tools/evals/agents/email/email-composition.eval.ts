import { emailAgent } from "@atlas/bundled-agents";
import { assert, assertStringIncludes } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Email agent - generation mode", async (t) => {
  await loadCredentials();

  // Ensure SendGrid is in sandbox mode for testing
  Deno.env.set("SENDGRID_SANDBOX_MODE", "true");

  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();

  await step(t, "Simple email composition", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt =
      "Send email to john@example.com with subject 'Test' saying hello and asking how the project is going";

    const startTime = performance.now();
    const result = await emailAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.response, "Should return success response");
    assertStringIncludes(result.response, "john@example.com");

    return { result, metrics, executionTimeMs };
  });

  await step(t, "Data-driven email - pricing report (SONOFF scenario)", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    // Simulate the failing SONOFF workspace scenario
    const pricingData = `
# SONOFF Zigbee Bridge Pro (ZB Bridge-P) Price Comparison: Poland and Portugal

## Best Deals for Shipping to Poland

1. **Allegro**: 49.38 PLN (~€10.89)
   - Base price: 49.38 PLN
   - Shipping: Varies by seller (typically 1-5 days delivery)
   - Total: ~49.38 PLN + shipping

2. **Media Expert**: 89.99 PLN (~€19.85)
   - Base price: 89.99 PLN
   - Shipping: Free with minimum purchase
   - Total: 89.99 PLN

3. **AliExpress**: $49.80 (~227.65 PLN)
   - Base price: $49.80
   - Shipping: Free international shipping
   - Extra discount: 5% off with coins
   - Total: $49.80

4. **ITEAD Studio**: $19.90 (~91.00 PLN)
   - Base price: $19.90
   - Shipping: Free standard shipping on orders over $89
   - Total: $19.90 + shipping

5. **Komputronik**: 99.90 PLN (~€22.03)
   - Base price: 99.90 PLN
   - Shipping: Typically ships in 1 day
   - Total: 99.90 PLN + shipping

## Best Deals for Shipping to Portugal

1. **SONOFF Official (EU)**: €24.02
   - Base price: €24.02
   - Shipping: Free shipping over €59
   - Total: €24.02 + shipping

2. **Loja InTek**: Price not specified
   - Base price: Not specified
   - Shipping: Free shipping on purchases over €60 to mainland Portugal
   - Total: Base price + shipping (if under €60)

3. **Smartify.pt**: Price not specified
   - Base price: Not specified
   - Shipping: Free shipping on purchases over €65 to Continental Portugal
   - Total: Base price + shipping (if under €65)

4. **AliExpress**: Price not specified
   - Base price: Not specified
   - Shipping: Free shipping
   - Additional discount: $0.71 coupon code if delayed
   - Total: Base price

5. **ITEAD Studio**: $19.90 (~€18.37)
   - Base price: $19.90
   - Shipping: Free standard shipping on orders over $89
   - Total: $19.90 + shipping
    `;

    const prompt = `
Create a professional email report for testuser@example-domain.test with the subject "SONOFF Zigbee Bridge Pro - Daily Price Report".

Format the pricing data below into two clear sections showing the 5 best offers for each destination (Poland and Portugal).
Include product links, base prices, shipping costs, and total prices for easy comparison.

Pricing Data:
${pricingData}
    `;

    const startTime = performance.now();
    const result = await emailAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.response, "Should return success response");
    assertStringIncludes(result.response, "testuser@example-domain.test");

    // Use LLM judge to validate email content quality
    const evaluation = await llmJudge({
      criteria: `
        The email response should contain:
        1. Pricing information for both Poland and Portugal destinations
        2. Multiple product offers (at least 3 for each destination)
        3. Price information in appropriate currencies (PLN, EUR, USD)
        4. Professional formatting suitable for an email report
        5. Subject line about SONOFF pricing
      `,
      agentOutput: JSON.stringify(result),
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  await step(t, "HTML formatted email - structured data", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `
Send email to team@test-company.example with subject "Q4 Metrics Report".

Create a professional HTML email from this data:
- Total Revenue: $1.2M (up 23% from Q3)
- New Customers: 145 (up 12%)
- Churn Rate: 2.1% (down from 2.8%)
- Top Products:
  1. Enterprise Plan - $450K revenue
  2. Professional Plan - $380K revenue
  3. Starter Plan - $370K revenue

Use HTML tables for the metrics and make it visually clear.
    `;

    const startTime = performance.now();
    const result = await emailAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.response, "Should return success response");
    assertStringIncludes(result.response, "team@test-company.example");

    // Validate HTML content generation
    const evaluation = await llmJudge({
      criteria: `
        The email should:
        1. Be addressed to team@test-company.example
        2. Have subject about Q4 Metrics
        3. Include all the numerical data provided (revenue, customers, churn rate, products)
        4. Use HTML formatting for better readability
        5. Present data in a structured, professional format
      `,
      agentOutput: JSON.stringify(result),
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  await step(t, "Large context email - meeting summary", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    // Generate large meeting notes (simulating complex context)
    const meetingNotes = `
Meeting Notes - Product Strategy Session
Date: October 13, 2025
Attendees: CEO, CTO, Product Manager, Engineering Lead, Design Lead

1. Q4 Product Roadmap Discussion
   - Feature A: Timeline extended to December due to technical complexity
   - Feature B: On track for November release
   - Feature C: Delayed to Q1 2026 pending customer feedback

2. Customer Feedback Analysis
   - 89% satisfaction rate (up from 84% last quarter)
   - Top 3 feature requests:
     a) Advanced analytics dashboard
     b) Mobile app improvements
     c) Integration with Salesforce
   - Pain points identified in onboarding process

3. Technical Architecture Decisions
   - Migration to microservices approved
   - Database optimization project prioritized
   - New monitoring stack evaluation in progress

4. Competitive Analysis
   - Competitor A launched similar feature
   - Competitor B raised $50M Series B
   - Market share holding steady at 12%

5. Budget Allocation
   - Engineering: $2.3M for Q4
   - Marketing: $1.8M for Q4
   - Sales: $1.5M for Q4

6. Action Items
   - CTO: Complete technical spec for Feature A by Oct 20
   - Product Manager: User research for Feature C by Oct 25
   - Engineering Lead: Database optimization plan by Oct 30
   - Design Lead: Onboarding flow redesign by Nov 5

7. Next Steps
   - Weekly sync meetings starting next Monday
   - Monthly stakeholder updates
   - Customer advisory board meeting in November
    `;

    const prompt = `
Send meeting summary email to stakeholders@test-company.example with subject "Product Strategy Session - Key Takeaways".

Summarize these meeting notes into a clear, actionable email:
${meetingNotes}
    `;

    const startTime = performance.now();
    const result = await emailAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.response, "Should return success response");
    assertStringIncludes(result.response, "stakeholders@test-company.example");

    const evaluation = await llmJudge({
      criteria: `
        The email should:
        1. Be sent to stakeholders@test-company.example
        2. Summarize the key points from the meeting
        3. Include action items with owners and deadlines
        4. Mention budget allocations
        5. Be professionally formatted and concise
      `,
      agentOutput: JSON.stringify(result),
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  await step(t, "Email with context and simple request", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `
Send a quick update to devteam@test-startup.example saying the deployment completed successfully
and the new feature is now live in production. Mention it went smoothly without issues.
    `;

    const startTime = performance.now();
    const result = await emailAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.response, "Should return success response");
    assertStringIncludes(result.response, "devteam@test-startup.example");

    const evaluation = await llmJudge({
      criteria: `
        The email should:
        1. Be addressed to devteam@test-startup.example
        2. Mention deployment completion
        3. State the feature is live in production
        4. Indicate it went smoothly
        5. Be concise and professional
      `,
      agentOutput: JSON.stringify(result),
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  await step(t, "Recipient extraction from context", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `
The user wants to email the pricing report to their boss. Their boss is Michael Johnson
at boss@test-company.example.

Create an email with subject "Weekly Pricing Analysis" and include:
- Average competitor price: $129.99
- Our price: $99.99
- Recommendation: Hold current pricing, we're competitive
    `;

    const startTime = performance.now();
    const result = await emailAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.response, "Should return success response");
    assertStringIncludes(result.response, "boss@test-company.example");

    const evaluation = await llmJudge({
      criteria: `
        The email should:
        1. Be sent to boss@test-company.example (extracted from context)
        2. Have subject about pricing analysis
        3. Include the three data points provided (competitor price, our price, recommendation)
        4. Be formatted professionally for a boss
      `,
      agentOutput: JSON.stringify(result),
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });
});
