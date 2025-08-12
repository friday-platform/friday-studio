import { AtlasDaemon, OPENAPI_DOCUMENTATION } from "@atlas/atlasd";
import { generateSpecs } from "hono-openapi";
import openapiTS, { astToString } from "openapi-typescript";
import { getAtlasDaemonUrl } from "@atlas/atlasd";

/**
 * Generate TypeScript types from the Atlas daemon OpenAPI spec
 * This integrates directly with the atlasd server configuration
 */
const app = new AtlasDaemon({ port: 0 }).getApp();

// Generate OpenAPI spec in memory
const spec = await generateSpecs(app, {
  documentation: {
    ...OPENAPI_DOCUMENTATION,
    servers: [
      { url: getAtlasDaemonUrl(), description: "Atlas Daemon Server" },
    ],
  },
});

// Generate TypeScript types from spec
// @ts-expect-error hono-openapi uses openapi-types which has slightly different type definitions
// than what openapi-typescript expects (missing index signatures for x- extensions).
// The spec is valid OpenAPI, this is purely a TypeScript type definition issue.
const ast = await openapiTS(spec);

// Convert AST to TypeScript string
await Deno.writeTextFile("./src/atlasd-types.gen.d.ts", astToString(ast));

console.log("✅ Generated OpenAPI types successfully");

Deno.exit(0);
