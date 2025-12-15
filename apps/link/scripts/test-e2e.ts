#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * End-to-end test script for Link + Cypher integration
 * Usage: deno run --allow-net --allow-env scripts/test-e2e.ts [user_id]
 * Requires: Link running on :3100, Cypher running on :8085, Postgres on :54322
 */

import * as jose from "jose";
import postgres from "postgres";

const userId = Deno.args[0] ?? "dev";
const baseUrl = "http://localhost:3100";
const pgUrl = "postgresql://postgres:postgres@localhost:54322/postgres";

/**
 * Generate unsigned JWT for dev mode testing.
 */
async function generateToken(userId: string): Promise<string> {
  return await new jose.UnsecuredJWT({ user_metadata: { tempest_user_id: userId } })
    .setSubject("test-user")
    .encode();
}

const token = await generateToken(userId);
const sql = postgres(pgUrl);

console.log("=== Link + Cypher E2E Test ===");
console.log(`User ID: ${userId}`);
console.log(`Token: ${token.slice(0, 50)}...`);
console.log("");

// Check services are running
console.log("--- Checking services ---");
try {
  await fetch(`${baseUrl}/health`);
  console.log("✓ Link is running");
} catch {
  console.log(`❌ Link not running on ${baseUrl}`);
  Deno.exit(1);
}

try {
  await fetch("http://localhost:8085/health");
  console.log("✓ Cypher is running");
} catch {
  console.log("⚠ Cypher health check failed (may still work)");
}

// Ensure user exists in database
console.log("");
console.log("--- Ensuring user exists ---");
await sql`
  INSERT INTO public."user" (id, full_name, email)
  VALUES (${userId}, 'Test User', ${`${userId}@test.local`})
  ON CONFLICT (id) DO NOTHING
`;
console.log(`✓ User '${userId}' exists`);

// Create credential
console.log("");
console.log("--- Creating credential ---");
const createResponse = await fetch(`${baseUrl}/v1/credentials/apikey`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    provider: "test",
    label: "e2e test key",
    secret: { key: "sk-secret-12345" },
  }),
});

const createResult = (await createResponse.json()) as { id?: string; error?: string };
console.log("Response:", JSON.stringify(createResult));

const credId = createResult.id;
if (!credId) {
  console.log("❌ Failed to create credential");
  await sql.end();
  Deno.exit(1);
}
console.log(`✓ Created credential: ${credId}`);

// Verify encrypted in database
console.log("");
console.log("--- Verifying encryption in database ---");
const [dbRow] = await sql<[{ encrypted_secret: string }]>`
  SELECT encrypted_secret FROM public.credential WHERE id = ${credId}
`;
if (dbRow.encrypted_secret.includes("sk-secret")) {
  console.log("❌ Secret not encrypted! Found plaintext in database");
  await sql.end();
  Deno.exit(1);
}
console.log(`✓ Secret is encrypted: ${dbRow.encrypted_secret.slice(0, 50)}...`);

// List credentials
console.log("");
console.log("--- Listing credentials ---");
const listResponse = await fetch(`${baseUrl}/v1/credentials/type/apikey`, {
  headers: { Authorization: `Bearer ${token}` },
});
const listResult = (await listResponse.json()) as Array<{ id: string }>;
console.log("Response:", JSON.stringify(listResult));
if (listResult.some((c) => c.id === credId)) {
  console.log("✓ Credential appears in list");
} else {
  console.log("❌ Credential not in list");
  await sql.end();
  Deno.exit(1);
}

// Get credential metadata (public - no secret)
console.log("");
console.log("--- Getting credential metadata (public) ---");
const getResponse = await fetch(`${baseUrl}/v1/credentials/${credId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const getResult = await getResponse.text();
console.log("Response:", getResult);
if (getResult.includes("secret")) {
  console.log("❌ Public endpoint leaked secret!");
  await sql.end();
  Deno.exit(1);
}
console.log("✓ Public endpoint does not expose secret");

// Get credential with secret (internal)
console.log("");
console.log("--- Getting credential with secret (internal) ---");
const internalResponse = await fetch(`${baseUrl}/internal/v1/credentials/${credId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const internalResult = await internalResponse.text();
console.log("Response:", internalResult);
if (internalResult.includes("sk-secret-12345")) {
  console.log("✓ Internal endpoint returns decrypted secret");
} else {
  console.log("❌ Internal endpoint did not return correct secret");
  await sql.end();
  Deno.exit(1);
}

// Delete credential (soft delete)
console.log("");
console.log("--- Deleting credential (soft delete) ---");
const deleteResponse = await fetch(`${baseUrl}/v1/credentials/${credId}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${token}` },
});
const deleteResult = await deleteResponse.text();
console.log("Response:", deleteResult);
console.log("✓ Delete request completed");

// Verify soft delete - should return 404
console.log("");
console.log("--- Verifying soft delete ---");
const getDeletedResponse = await fetch(`${baseUrl}/v1/credentials/${credId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (getDeletedResponse.status === 404) {
  console.log("✓ Credential returns 404 after delete");
} else {
  console.log(`❌ Expected 404, got ${getDeletedResponse.status}`);
  await sql.end();
  Deno.exit(1);
}

// Verify deleted_at is set in database
const [deletedRow] = await sql<[{ deleted_at: Date | null }]>`
  SELECT deleted_at FROM public.credential WHERE id = ${credId}
`;
if (deletedRow.deleted_at) {
  console.log(`✓ deleted_at is set: ${deletedRow.deleted_at.toISOString()}`);
} else {
  console.log("❌ deleted_at not set (hard delete instead of soft delete?)");
  await sql.end();
  Deno.exit(1);
}

console.log("");
console.log("=== All tests passed! ===");

await sql.end();
