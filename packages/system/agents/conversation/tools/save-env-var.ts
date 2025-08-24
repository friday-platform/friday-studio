import { tool } from "ai";
import { z } from "zod/v4";

/**
 * Environment variable save tool - Save environment variables to .env file
 */
export const atlas_save_env_var = tool({
  description: "Save environment variables to the .env file in the project root.",
  inputSchema: z
    .object({
      key: z
        .string()
        .min(1, "Environment variable key cannot be empty")
        .describe(
          "Environment variable name (e.g., API_KEY, DATABASE_URL). Should follow standard naming conventions.",
        ),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .describe("Environment variable value. Will be converted to string for storage."),
    })
    .refine((data) => {
      // Validate environment variable key format
      const keyRegex = /^[A-Za-z][A-Za-z0-9_]*$/;
      if (!keyRegex.test(data.key)) {
        if (/^[0-9]/.test(data.key)) {
          throw new Error("Environment variable key must start with a letter");
        }
        throw new Error(
          "Environment variable key can only contain letters, numbers, and underscores",
        );
      }
      return true;
    }),
  execute: async ({ key, value }) => {
    try {
      // Convert value to string for environment variable storage
      const stringValue = String(value);

      // Read current .env file or create empty content
      let envContent = "";
      const envFilePath = ".env";

      try {
        envContent = await Deno.readTextFile(envFilePath);
      } catch {
        // .env file doesn't exist, start with empty content
        envContent = "";
      }

      // Parse existing env file
      const lines = envContent.split("\n");
      const updatedLines: string[] = [];
      let keyFound = false;

      // Process existing lines
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith(`${key}=`)) {
          // Replace existing key
          updatedLines.push(`${key}=${stringValue}`);
          keyFound = true;
        } else {
          updatedLines.push(line);
        }
      }

      // Add new key if not found
      if (!keyFound) {
        if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
          updatedLines.push(""); // Add blank line before new env var
        }
        updatedLines.push(`${key}=${stringValue}`);
      }

      // Write updated content back to .env file
      const newContent = updatedLines.join("\n");
      await Deno.writeTextFile(envFilePath, newContent);

      // Get file stats for confirmation
      const stats = await Deno.stat(envFilePath);

      return {
        success: true,
        key,
        value: stringValue,
        stored: true,
        filePath: envFilePath,
        bytesWritten: stats.size,
      };
    } catch {
      throw new Error(`Failed to save environment variable`);
    }
  },
});
