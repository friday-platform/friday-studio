import { env } from "$env/dynamic/private";

export const BOUNCE_URL =
  env.BOUNCE_URL || "https://atlas-bounce.atlas-operator.svc.cluster.local:8083";
