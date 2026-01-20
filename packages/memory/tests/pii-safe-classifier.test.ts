/**
 * Tests for PII-Safe Memory Classifier
 *
 * Tests the source-aware PII filtering system to ensure PII data
 * is only extracted from trusted sources (user input).
 */

import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/mecmf-interfaces.ts";
import { DEFAULT_PII_CONFIG, PIISafeMemoryClassifier } from "../src/pii-safe-classifier.ts";

// Test data with various PII types
const TEST_CONTENT = {
  // User input with PII - should be extracted
  userWithPII: "My email is john.doe@company.com and my phone is +1-555-0123. Contact me at work.",

  // Agent output with PII - should be filtered
  agentWithPII:
    "The user's email john.doe@company.com was processed successfully. Phone: +1-555-0123",

  // Tool output with random PII from web scraping - should be filtered
  toolWithPII: "Found contact info: support@example.com, CEO: Jane Smith, Phone: +1-800-555-0199",

  // Non-PII content - should always be allowed
  nonPII: "The system uses TypeScript and processes data through the API gateway.",

  // Mixed content with various entity types
  mixed: "The API endpoint https://api.example.com returns JSON data. User ID: uuid-12345",
};

describe("PII Safe Classifier", () => {
  it("Constructor and Configuration", () => {
    const classifier = new PIISafeMemoryClassifier();
    const stats = classifier.getSourceStatistics();

    expect(stats.piiTypesRestricted).toEqual(DEFAULT_PII_CONFIG.restrictedPIITypes);
    expect(stats.trustedSources).toEqual(DEFAULT_PII_CONFIG.trustedSources);
    expect(stats.extractionSettings.emails).toEqual(true);
    expect(stats.extractionSettings.phones).toEqual(true);
    expect(stats.extractionSettings.names).toEqual(true);
  });

  it("Custom Configuration", () => {
    const classifier = new PIISafeMemoryClassifier({
      extractEmails: false,
      trustedSources: [MemorySource.USER_INPUT, MemorySource.AGENT_OUTPUT],
      minPIIConfidence: 0.9,
    });

    const stats = classifier.getSourceStatistics();

    expect(stats.extractionSettings.emails).toEqual(false);
    expect(stats.trustedSources.length).toEqual(2);
    expect(stats.minConfidenceThreshold).toEqual(0.9);
  });

  it("User Input PII Extraction", () => {
    const classifier = new PIISafeMemoryClassifier();

    // User input should extract PII
    const entities = classifier.extractKeyEntities(
      TEST_CONTENT.userWithPII,
      MemorySource.USER_INPUT,
    );

    const emails = entities.filter((e) => e.type === "email");
    const phones = entities.filter((e) => e.type === "phone");

    expect(emails.length).toEqual(1);
    expect(emails[0]?.name).toEqual("john.doe@company.com");
    expect(phones.length).toEqual(1);
    expect(phones[0]?.name).toEqual("+1-555-0123");
  });

  it("Agent Output PII Filtering", () => {
    const classifier = new PIISafeMemoryClassifier();

    // Agent output should filter PII
    const entities = classifier.extractKeyEntities(
      TEST_CONTENT.agentWithPII,
      MemorySource.AGENT_OUTPUT,
    );

    const emails = entities.filter((e) => e.type === "email");
    const phones = entities.filter((e) => e.type === "phone");

    // PII should be filtered out
    expect(emails.length).toEqual(0);
    expect(phones.length).toEqual(0);
  });

  it("Tool Output PII Filtering", () => {
    const classifier = new PIISafeMemoryClassifier();

    // Tool output should filter PII
    const entities = classifier.extractKeyEntities(
      TEST_CONTENT.toolWithPII,
      MemorySource.TOOL_OUTPUT,
    );

    const emails = entities.filter((e) => e.type === "email");
    const phones = entities.filter((e) => e.type === "phone");
    const names = entities.filter((e) => e.type === "name");

    // All PII should be filtered out
    expect(emails.length).toEqual(0);
    expect(phones.length).toEqual(0);
    expect(names.length).toEqual(0);
  });

  it("Confidence Threshold Filtering", () => {
    const classifier = new PIISafeMemoryClassifier({
      minPIIConfidence: 0.95, // Very high threshold
    });

    // Even with user input, low-confidence PII should be filtered
    const entities = classifier.extractKeyEntities(
      "Maybe contact info: test@test", // Low confidence email
      MemorySource.USER_INPUT,
    );

    // Should filter low-confidence PII even from trusted sources
    const lowConfidenceEmails = entities.filter((e) => e.type === "email" && e.confidence < 0.95);
    expect(lowConfidenceEmails.length).toEqual(0);
  });

  it("Trusted Source Management", () => {
    const classifier = new PIISafeMemoryClassifier();

    // Initially only USER_INPUT is trusted
    expect(classifier.isTrustedSource(MemorySource.USER_INPUT)).toEqual(true);
    expect(classifier.isTrustedSource(MemorySource.AGENT_OUTPUT)).toEqual(false);

    // Add AGENT_OUTPUT as trusted
    classifier.addTrustedSource(MemorySource.AGENT_OUTPUT);
    expect(classifier.isTrustedSource(MemorySource.AGENT_OUTPUT)).toEqual(true);

    // Remove USER_INPUT as trusted
    classifier.removeTrustedSource(MemorySource.USER_INPUT);
    expect(classifier.isTrustedSource(MemorySource.USER_INPUT)).toEqual(false);
  });

  it("Configuration Updates", () => {
    const classifier = new PIISafeMemoryClassifier();

    // Initially emails are enabled
    let entities = classifier.extractKeyEntities(
      "Contact: test@example.com",
      MemorySource.USER_INPUT,
    );
    let emails = entities.filter((e) => e.type === "email");
    expect(emails.length).toEqual(1);

    // Disable email extraction
    classifier.updatePIIConfig({ extractEmails: false });

    entities = classifier.extractKeyEntities("Contact: test@example.com", MemorySource.USER_INPUT);
    emails = entities.filter((e) => e.type === "email");
    expect(emails.length).toEqual(0);
  });

  it("Source Metadata Preservation", () => {
    const classifier = new PIISafeMemoryClassifier();

    const sourceMetadata = {
      agentId: "test-agent",
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    const entitiesWithSource = classifier.extractEntitiesWithSource(
      TEST_CONTENT.nonPII,
      MemorySource.AGENT_OUTPUT,
      sourceMetadata,
    );

    // Verify source information is preserved
    for (const entity of entitiesWithSource) {
      expect(entity.source).toEqual(MemorySource.AGENT_OUTPUT);
      expect(entity.sourceMetadata).toEqual(sourceMetadata);
    }
  });

  it("Edge Cases", () => {
    const classifier = new PIISafeMemoryClassifier();

    // Empty content
    let entities = classifier.extractKeyEntities("", MemorySource.USER_INPUT);
    expect(entities.length).toEqual(0);

    // Very long content
    const longContent = "test@example.com ".repeat(1000);
    entities = classifier.extractKeyEntities(longContent, MemorySource.USER_INPUT);
    // Should handle long content gracefully
    expect(entities.filter((e) => e.type === "email").length > 0).toEqual(true);

    // Special characters and unicode
    entities = classifier.extractKeyEntities(
      "联系方式：test@example.com 📧",
      MemorySource.USER_INPUT,
    );
    const emails = entities.filter((e) => e.type === "email");
    expect(emails.length).toEqual(1);
  });
});
