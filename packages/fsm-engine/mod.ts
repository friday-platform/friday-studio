/**
 * @atlas/fsm-engine
 *
 * FSM execution engine with code-based guards and actions.
 * Executes finite state machines defined in YAML with TypeScript functions.
 */

// Document schemas and utilities
export * from "./document-schemas.ts";
// Core engine and execution
export type { FSMEngineOptions } from "./fsm-engine.ts";
export { FSMEngine } from "./fsm-engine.ts";
export { jsonSchemaToZod, validateJSONSchema } from "./json-schema-to-zod.ts";
// LLM integration
export { AtlasLLMProviderAdapter } from "./llm-provider-adapter.ts";
// FSM loader with validation
export { createEngine, loadFromFile, loadFromYAML } from "./loader.ts";
// MCP tools for FSM operations
export * from "./mcp-tools/index.ts";
// Testing utilities
export { TestRunner } from "./mcp-tools/lib/runner.ts";
export { TestDefinitionSchema, TestSuiteSchema } from "./mcp-tools/lib/schema.ts";
export type {
  TestDefinition,
  TestResult,
  TestSuite,
  TestSuiteResult,
} from "./mcp-tools/lib/types.ts";
// Schema definitions
export * from "./schema.ts";
// Serialization
export * as serializer from "./serializer.ts";
// Core types
export * from "./types.ts";
// Validation
export type { ValidationResult } from "./validator.ts";
export { validateFSMStructure } from "./validator.ts";
