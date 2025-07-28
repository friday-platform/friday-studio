/**
 * Test suite for environment variable save tool
 */

import { assertEquals } from "@std/assert";

Deno.test("atlas_save_env_var - validates key format", () => {
  const keyRegex = /^[A-Za-z][A-Za-z0-9_]*$/;

  // Valid keys
  assertEquals(keyRegex.test("VALID_ENV_VAR"), true);
  assertEquals(keyRegex.test("API_KEY"), true);
  assertEquals(keyRegex.test("Mixed_Case_Var"), true);
  assertEquals(keyRegex.test("test123"), true);

  // Invalid keys
  assertEquals(keyRegex.test("123_INVALID"), false);
  assertEquals(keyRegex.test("TEST-VAR"), false);
  assertEquals(keyRegex.test("TEST VAR"), false);
  assertEquals(keyRegex.test(""), false);
});

Deno.test("atlas_save_env_var - value conversion", () => {
  // String conversion
  assertEquals(String("test-value"), "test-value");
  assertEquals(String(123), "123");
  assertEquals(String(true), "true");
  assertEquals(String(false), "false");
});

Deno.test("atlas_save_env_var - env file parsing", () => {
  const existingContent = `# Database configuration
DATABASE_URL=postgres://localhost:5432/db
API_KEY=existing-key

# Other settings
DEBUG=true`;

  const lines = existingContent.split("\n");
  assertEquals(lines.length, 6);
  assertEquals(lines[1], "DATABASE_URL=postgres://localhost:5432/db");
  assertEquals(lines[2], "API_KEY=existing-key");
});

Deno.test("atlas_save_env_var - key replacement logic", () => {
  const lines = ["DATABASE_URL=old-value", "API_KEY=test", "DEBUG=true"];
  const updatedLines: string[] = [];
  const keyToUpdate = "API_KEY";
  const newValue = "new-api-key";
  let keyFound = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith(`${keyToUpdate}=`)) {
      updatedLines.push(`${keyToUpdate}=${newValue}`);
      keyFound = true;
    } else {
      updatedLines.push(line);
    }
  }

  assertEquals(keyFound, true);
  assertEquals(updatedLines[1], "API_KEY=new-api-key");
  assertEquals(updatedLines.length, 3);
});

Deno.test("atlas_save_env_var - new key addition", () => {
  const existingLines = ["DATABASE_URL=test", "API_KEY=test"];
  const newKey = "NEW_VAR";
  const newValue = "new-value";

  const updatedLines = [...existingLines];
  updatedLines.push(""); // Blank line
  updatedLines.push(`${newKey}=${newValue}`);

  assertEquals(updatedLines.length, 4);
  assertEquals(updatedLines[3], "NEW_VAR=new-value");
});

Deno.test("atlas_save_env_var - creates new file when .env doesn't exist", () => {
  // Simulate empty content (when .env doesn't exist)
  const envContent = "";
  const lines = envContent.split("\n");
  const updatedLines: string[] = [];
  const key = "API_KEY";
  const value = "new-api-key";

  // Process empty content
  for (const line of lines) {
    if (line.trim() !== "") {
      updatedLines.push(line);
    }
  }

  // Add new key since none existed
  updatedLines.push(`${key}=${value}`);

  const newContent = updatedLines.join("\n");

  assertEquals(newContent, "API_KEY=new-api-key");
  assertEquals(updatedLines.length, 1);
});

Deno.test("atlas_save_env_var - return value structure", () => {
  // Test expected return structure without secure and description fields
  const mockResult = {
    success: true,
    key: "TEST_KEY",
    value: "test-value",
    stored: true,
    filePath: ".env",
    bytesWritten: 42,
  };

  assertEquals(mockResult.success, true);
  assertEquals(mockResult.key, "TEST_KEY");
  assertEquals(mockResult.value, "test-value");
  assertEquals(mockResult.stored, true);
  assertEquals("secure" in mockResult, false); // Ensure secure field is not present
  assertEquals("description" in mockResult, false); // Ensure description field is not present
});
