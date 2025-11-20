/**
 * Type definitions for FSM transition testing
 */

import type { Document, EmittedEvent, FSMDefinition, Signal } from "../../types.ts";

export interface TestDefinition {
  /** Test name */
  name: string;

  /** Optional description */
  description?: string;

  /** FSM definition to test */
  fsm: FSMDefinition;

  /** Initial state setup */
  setup: {
    /** Starting state name */
    state: string;

    /** Initial documents */
    documents?: Document[];
  };

  /** Signal to send */
  signal: Signal;

  /** Assertions to validate after signal processing */
  assertions: {
    /** Expected final state */
    state: string;

    /** Expected documents (partial match) */
    documents?: Array<{
      id: string;
      data?: Record<string, unknown>; // If omitted, just checks document exists
    }>;

    /** Expected emitted events */
    emittedEvents?: Array<{ event: string; data?: Record<string, unknown> }>;

    /** Custom validation function (optional) */
    custom?: string; // TypeScript code that exports a validation function
  };
}

export interface TestResult {
  /** Test name */
  name: string;

  /** Test description if provided */
  description?: string;

  /** Whether test passed */
  passed: boolean;

  /** Error messages if test failed */
  errors: string[];

  /** Actual final state */
  actualState: string;

  /** Actual final documents */
  actualDocuments: Document[];

  /** Actual emitted events */
  actualEvents: EmittedEvent[];

  /** Execution time in ms */
  executionTime: number;
}

export interface TestSuite {
  /** Suite name */
  name: string;

  /** Test definitions */
  tests: TestDefinition[];
}

export interface TestSuiteResult {
  /** Suite name */
  name: string;

  /** Individual test results */
  results: TestResult[];

  /** Total tests */
  total: number;

  /** Passed tests */
  passed: number;

  /** Failed tests */
  failed: number;

  /** Total execution time in ms */
  totalTime: number;
}
