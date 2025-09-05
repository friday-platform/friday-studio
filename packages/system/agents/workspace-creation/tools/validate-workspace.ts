import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

export function getValidateWorkspaceTool(builder: WorkspaceBuilder, logger: Logger) {
  return tool({
    description: "Validate workspace coherence and completeness",
    inputSchema: z.object({}),
    execute: () => {
      logger.debug("Validating workspace...");
      const validation = builder.validateWorkspace();
      const summary = builder.getSummary();

      // Extract missing agent names from validation errors
      const missingAgents: string[] = [];
      for (const error of validation.errors) {
        const match = error.match(/references non-existent agent '([^']+)'/);
        const missingAgent = match?.at(1);
        if (missingAgent) {
          missingAgents.push(missingAgent);
        }
      }

      // Add helpful suggestions for missing agents
      if (missingAgents.length > 0) {
        validation.suggestions = validation.suggestions || [];
        validation.suggestions.push(
          `Missing agents detected: ${missingAgents.join(", ")}`,
          "These agents were referenced in jobs but not generated",
          "Action: Regenerate the missing agents before attempting to fix jobs",
        );

        logger.warn("Validation found missing agents", { missingAgents });
      }

      // Check if we have a mismatch between expected and actual agent count
      if (validation.errors.some((e) => e.includes("non-existent agent"))) {
        validation.suggestions = validation.suggestions || [];
        validation.suggestions.push(
          "Tip: Use getSummary to verify all parallel agent generations completed successfully",
        );
      }

      logger.info("Workspace validation complete", {
        summary,
        isValid: validation.success,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
        missingAgents,
      });

      return {
        isValid: validation.success,
        errors: validation.errors,
        warnings: validation.warnings,
        suggestions: validation.suggestions,
        summary,
        missingAgents: missingAgents.length > 0 ? missingAgents : undefined,
      };
    },
  });
}
