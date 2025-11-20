/**
 * FSM Loader - Loads and validates FSM definitions before engine initialization
 *
 * Separates concerns: loading/validation happens here, execution in FSMEngine
 */

import type { FSMEngineOptions } from "./fsm-engine.ts";
import { FSMEngine } from "./fsm-engine.ts";
import * as serializer from "./serializer.ts";
import type { FSMDefinition } from "./types.ts";
import { validateFSMStructure } from "./validator.ts";

/**
 * Load FSM from YAML string with validation
 * Performs structural (Zod) and semantic (validator.ts) checks before engine creation
 */
export function loadFromYAML(yaml: string, options: FSMEngineOptions): FSMEngine {
  // 1. Parse and validate structure with Zod
  const definition = serializer.fromYAML(yaml);

  // 2. Validate semantics with validator
  const validation = validateFSMStructure(definition);
  if (!validation.valid) {
    throw new Error(`FSM validation failed:\n${validation.errors.join("\n")}`);
  }

  // 3. Create engine with validated definition
  return new FSMEngine(definition, options);
}

/**
 * Load FSM from file with validation
 */
export async function loadFromFile(path: string, options: FSMEngineOptions): Promise<FSMEngine> {
  const yaml = await Deno.readTextFile(path);
  return loadFromYAML(yaml, options);
}

/**
 * Create FSM engine from pre-validated definition
 * Use this when you've already validated the definition
 */
export function createEngine(definition: FSMDefinition, options: FSMEngineOptions): FSMEngine {
  return new FSMEngine(definition, options);
}
