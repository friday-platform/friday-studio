import { writeFile } from "node:fs/promises";
import process from "node:process";
import { AtlasDaemon, getAtlasDaemonUrl, OPENAPI_DOCUMENTATION } from "@atlas/atlasd";
import { generateSpecs } from "hono-openapi";
import openapiTS, { astToString } from "openapi-typescript";

/**
 * Generate TypeScript types from the Atlas daemon OpenAPI spec
 * This integrates directly with the atlasd server configuration
 */
const app = new AtlasDaemon({ port: 0 }).getApp();

// Generate OpenAPI spec in memory
const spec = await generateSpecs(app, {
  documentation: {
    ...OPENAPI_DOCUMENTATION,
    servers: [{ url: getAtlasDaemonUrl(), description: "Atlas Daemon Server" }],
  },
});

// Generate TypeScript types from spec
// @ts-expect-error hono-openapi uses openapi-types which has slightly different type definitions
// than what openapi-typescript expects (missing index signatures for x- extensions).
// The spec is valid OpenAPI, this is purely a TypeScript type definition issue.
const ast = await openapiTS(spec);

// Convert AST to TypeScript string
await writeFile("./src/atlasd-types.gen.d.ts", astToString(ast), "utf-8");

console.log("✅ Generated OpenAPI types successfully");

process.exit(0);
