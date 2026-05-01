/**
 * Zod schemas for FSM test definitions
 */

import { z } from "zod";
import { DocumentSchema, FSMDefinitionSchema, SignalSchema } from "../../schema.ts";

const TestSetupSchema = z.object({
  state: z.string(),
  documents: z.array(DocumentSchema).optional(),
});

const ExpectedDocumentSchema = z.object({
  id: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const ExpectedEventSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const TestAssertionsSchema = z.object({
  state: z.string(),
  documents: z.array(ExpectedDocumentSchema).optional(),
  emittedEvents: z.array(ExpectedEventSchema).optional(),
  custom: z.string().optional(),
});

export const TestDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  fsm: FSMDefinitionSchema,
  setup: TestSetupSchema,
  signal: SignalSchema,
  assertions: TestAssertionsSchema,
});

export const TestSuiteSchema = z.object({ name: z.string(), tests: z.array(TestDefinitionSchema) });
