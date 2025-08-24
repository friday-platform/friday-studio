import { type AnthropicProviderOptions, anthropic } from "@ai-sdk/anthropic";
import { type AtlasAgent, createAgent } from "@atlas/agent-sdk";
import { streamResults } from "@atlas/agent-sdk/vercel-helpers";
import { stepCountIs, streamText } from "ai";

const HAIKU_SYSTEM_PROMPT = `You are a haiku poet. Use the fetch tool to read a given website. Transform the headline of the website into a beautiful haiku (5-7-5 syllable structure).

Follow these rules:
1. First line: 5 syllables
2. Second line: 7 syllables
3. Third line: 5 syllables
4. Capture the essence or emotion of the input
5. Use nature imagery when appropriate
6. Keep it simple and evocative

Respond ONLY with the haiku, no explanations or additional text.`;

/**
 * Haiku Agent - Transforms user input into poetic haiku form
 *
 * This bundled agent uses the Anthropic Claude model to create haikus
 * from any user input, following the traditional 5-7-5 syllable structure.
 */
export const haikuAgent: AtlasAgent = createAgent({
  mcp: {
    fetch: { transport: { type: "stdio", command: "npx", args: ["-y", "mcp-fetch-server"] } },
  },
  id: "haiku",
  displayName: "Haiku Poet",
  description: "Transforms any input into a beautiful haiku poem",
  version: "1.0.0",
  expertise: {
    domains: ["poetry", "creative-writing", "linguistics"],
    capabilities: [
      "transform text to haiku",
      "maintain 5-7-5 syllable structure",
      "capture emotional essence",
      "create evocative imagery",
    ],
    examples: [
      "turn this into a haiku: debugging code late at night",
      "make a haiku about: coffee in the morning",
      "haiku this: Atlas agent orchestration platform",
    ],
  },

  async handler(prompt, { stream, tools, logger }) {
    try {
      logger.info("Generating haiku", {
        promptLength: prompt.length,
        toolCount: Object.keys(tools).length,
      });

      const result = streamText({
        model: anthropic("claude-3-7-sonnet-latest"),
        system: HAIKU_SYSTEM_PROMPT,
        prompt,
        temperature: 0.5,
        stopWhen: stepCountIs(20),
        tools,
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 12000 },
          } satisfies AnthropicProviderOptions,
        },
      });

      logger.debug("Streaming haiku response");
      const response = await streamResults(result, stream);

      logger.info("Haiku generated successfully", { response: response.response });

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

      logger.error("Failed to generate haiku", { error, errorMessage });

      // Emit error to stream
      stream.emit({ type: "error", error: errorMessage });

      return {
        response: `Failed to generate haiku: ${errorMessage}`,
        metadata: { error: true, errorMessage },
      };
    }
  },

  // Optional: Define environment requirements
  environment: {
    required: [{ name: "ANTHROPIC_API_KEY", description: "Anthropic API key for Claude access" }],
  },
});
