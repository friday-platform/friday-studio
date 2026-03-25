import { Hono } from "hono";
import { getAgentExpertise } from "./expertise.ts";
import { getAgent } from "./get.ts";
import { listAgents } from "./list.ts";
import { getAgentPreflight } from "./preflight.ts";

export const agents = new Hono();

agents.route("/", listAgents);
agents.route("/", getAgent);
agents.route("/", getAgentExpertise);
agents.route("/", getAgentPreflight);
