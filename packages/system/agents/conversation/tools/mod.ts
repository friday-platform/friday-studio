/**
 * Conversation Agent Tools Module
 *
 * Consolidates all conversation agent tools and exports them as AtlasTools.
 * These tools are used by the conversation agent for:
 * - Streaming events back to the client
 * - Managing conversation storage/history
 * - Todo list management
 * - Workspace creation and updating
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { createSkillTool } from "./create-skill.ts";
import { displayArtifact } from "./display-artifact.ts";
import { takeNoteTool } from "./scratchpad-tools.ts";

/**
 * All conversation agent tools exported as AtlasTools.
 * These can be spread directly onto the tools object in the agent handler.
 */
export const conversationTools: AtlasTools = {
  take_note: takeNoteTool,
  display_artifact: displayArtifact,
  create_skill: createSkillTool,
};
