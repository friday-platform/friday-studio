import { Hono } from "hono";
import { listAgents } from "./list.ts";
import { getAgent } from "./get.ts";
import { getAgentExpertise } from "./expertise.ts";

export const agents = new Hono();

agents.route("/", listAgents);
agents.route("/", getAgent);
agents.route("/", getAgentExpertise);
