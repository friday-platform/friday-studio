import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseOperationConfig } from "./operation-parser.ts";

const CreateNoteOp = z.object({
  operation: z.literal("create-note"),
  ticketId: z.string().min(1),
  body: z.string().min(1),
});
const NoopOp = z.object({
  operation: z.literal("noop"),
  reason: z.string().optional(),
  skipped: z.boolean().optional(),
});
const Schema = z.discriminatedUnion("operation", [CreateNoteOp, NoopOp]);

describe("parseOperationConfig", () => {
  it("parses a JSON-fenced envelope", () => {
    const prompt =
      "Some instructions\n\n```json\n" +
      `{"operation":"create-note","ticketId":"5501","body":"<p>x</p>"}` +
      "\n```";
    const result = parseOperationConfig(prompt, Schema);
    expect(result).toEqual({ operation: "create-note", ticketId: "5501", body: "<p>x</p>" });
  });

  it("parses a brace-balanced envelope outside any code fence", () => {
    const prompt = `Header\n\n{"operation":"noop","skipped":true,"reason":"x"}\n\nMore text`;
    const result = parseOperationConfig(prompt, Schema);
    expect(result).toEqual({ operation: "noop", skipped: true, reason: "x" });
  });

  it("parses the whole prompt as JSON when nothing else matches", () => {
    const prompt = `{"operation":"create-note","ticketId":"5501","body":"<p>x</p>"}`;
    const result = parseOperationConfig(prompt, Schema);
    expect(result).toEqual({ operation: "create-note", ticketId: "5501", body: "<p>x</p>" });
  });

  it("throws when no schema-matching JSON is present", () => {
    const prompt = "Just some plain text with no envelope here.";
    expect(() => parseOperationConfig(prompt, Schema)).toThrow(/Could not parse operation config/);
  });

  // The behavior that prevents instruction-text JSON examples (or accumulated
  // upstream documents) from poisoning the dispatch when later, intended
  // envelopes are appended later in the prompt.
  describe("prefers the last matching envelope when multiple are present", () => {
    it("picks the second of two fenced envelopes", () => {
      const prompt = [
        "### Document: briefing-prompt",
        "```json",
        `{"operation":"create-note","ticketId":"100","body":"<p>briefing</p>"}`,
        "```",
        "",
        "### Document: reply-prompt",
        "```json",
        `{"operation":"create-note","ticketId":"100","body":"<p>customer reply</p>"}`,
        "```",
      ].join("\n");
      const result = parseOperationConfig(prompt, Schema);
      expect(result).toEqual({
        operation: "create-note",
        ticketId: "100",
        body: "<p>customer reply</p>",
      });
    });

    it("picks the last brace-balanced envelope when multiple match", () => {
      const prompt =
        `Earlier envelope: {"operation":"noop","skipped":true,"reason":"first"}` +
        ` and a later one {"operation":"noop","skipped":true,"reason":"second"}.`;
      const result = parseOperationConfig(prompt, Schema);
      expect(result).toEqual({ operation: "noop", skipped: true, reason: "second" });
    });

    it("ignores a noop example in instruction text when a real envelope follows in a fenced block", () => {
      // This is the scenario that motivated the change. An instruction-text
      // JSON example used to poison the parser; with last-match semantics
      // the real envelope (later in the prompt) wins.
      const prompt = [
        `If the envelope has "operation":"noop" return early. Example:`,
        `{"operation":"noop","skipped":true,"reason":"example only"}`,
        "",
        "### Document: reply-prompt",
        "```json",
        `{"operation":"create-note","ticketId":"5501","body":"<p>real envelope</p>"}`,
        "```",
      ].join("\n");
      const result = parseOperationConfig(prompt, Schema);
      expect(result).toEqual({
        operation: "create-note",
        ticketId: "5501",
        body: "<p>real envelope</p>",
      });
    });
  });
});
