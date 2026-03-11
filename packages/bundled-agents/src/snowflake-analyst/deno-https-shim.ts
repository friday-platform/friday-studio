/**
 * Deno compatibility shim for snowflake-sdk.
 *
 * snowflake-sdk's HttpsOcspAgent uses ES5-style inheritance:
 *   `HttpsAgent.apply(this, [options])`
 * This fails under Deno because `https.Agent` is an ES6 class that requires `new`.
 *
 * This file MUST be imported before snowflake-sdk so it patches `https.Agent`
 * before the SDK captures a reference to it.
 */
import https from "node:https";

const OriginalAgent = https.Agent;

function PatchedAgent(
  this: InstanceType<typeof OriginalAgent>,
  ...args: ConstructorParameters<typeof OriginalAgent>
) {
  // Support both `new PatchedAgent()` and `PatchedAgent.apply(this, args)` patterns
  if (!(this instanceof PatchedAgent)) {
    // Called without `new` — redirect to `new` invocation
    return Reflect.construct(OriginalAgent, args, PatchedAgent);
  }
  return Reflect.construct(OriginalAgent, args, new.target || PatchedAgent);
}

PatchedAgent.prototype = OriginalAgent.prototype;
Object.setPrototypeOf(PatchedAgent, OriginalAgent);

// @ts-expect-error -- intentional monkey-patch for Deno+snowflake-sdk compat
https.Agent = PatchedAgent;
