/**
 * Template registry for Atlas workspace initialization
 * Provides metadata about available workspace templates
 */

import type { TemplateInfo } from "@atlas/storage";

/**
 * Available workspace templates
 */
export const templates: TemplateInfo[] = [
  {
    id: "telephone",
    name: "Telephone Game",
    description:
      "Multi-agent message transformation pipeline that demonstrates sequential agent processing",
    tags: ["multi-agent", "llm", "pipeline", "example"],
  },
  {
    id: "echo",
    name: "Echo",
    description:
      "Simple echo workspace for getting started - receives and returns messages with minimal transformation",
    tags: ["beginner", "simple", "cli"],
  },
  {
    id: "minimal",
    name: "Minimal",
    description:
      "Blank workspace with comprehensive documentation - all options commented for easy customization",
    tags: ["blank", "documentation", "starter"],
  },
];

/**
 * Get template info by ID
 */
export function getTemplateById(templateId: string): TemplateInfo | undefined {
  return templates.find((t) => t.id === templateId);
}

/**
 * Get templates by tag
 */
export function getTemplatesByTag(tag: string): TemplateInfo[] {
  return templates.filter((t) => t.tags?.includes(tag) || false);
}
