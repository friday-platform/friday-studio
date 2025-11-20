/**
 * YAML serialization utilities for FSMDefinition
 */

import { parse, stringify } from "@std/yaml";
import { z } from "zod";
import { FSMDefinitionSchema } from "./schema.ts";
import type { FSMDefinition } from "./types.ts";

/**
 * Schema for YAML file structure
 * FSM definitions must be wrapped in an fsm property
 */
const FSMYAMLSchema = z.object({ fsm: FSMDefinitionSchema });

export function fromYAML(yaml: string): FSMDefinition {
  const parsed = parse(yaml);
  return FSMYAMLSchema.parse(parsed).fsm;
}

export function toYAML(definition: FSMDefinition): string {
  FSMDefinitionSchema.parse(definition);
  return stringify({ fsm: definition });
}
