import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Schema validates Snowflake connection credentials.
 * Required: account, username, password, warehouse, role.
 * Optional: database, schema (for narrowing default context).
 */
const SnowflakeSecretSchema = z.object({
  account: z.string().min(1, "Snowflake account identifier is required"),
  username: z.string().min(1, "Snowflake username is required"),
  password: z.string().min(1, "Snowflake password is required"),
  warehouse: z.string().min(1, "Snowflake warehouse is required"),
  role: z.string().min(1, "Snowflake role is required"),
  database: z.string().optional(),
  schema: z.string().optional(),
});

export const snowflakeProvider = defineApiKeyProvider({
  id: "snowflake",
  displayName: "Snowflake",
  description: "Snowflake data warehouse credentials",
  docsUrl: "https://docs.snowflake.com/en/developer-guide/drivers",
  secretSchema: SnowflakeSecretSchema,
  setupInstructions: `
1. Log in to your Snowflake account
2. Note your **account identifier** (e.g. \`xy12345.us-east-1\`)
3. Enter your username, password, warehouse, and role
4. Optionally specify a default database and schema
`,
});
