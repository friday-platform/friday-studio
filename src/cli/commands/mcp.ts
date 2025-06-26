export const command = "mcp <command>";
export const desc = "Model Context Protocol server commands";

// Manually register subcommands
export const builder = (yargs: any) => {
  return yargs
    .command(
      "serve",
      "Start Atlas MCP server",
      async (y: any) => {
        const { builder } = await import("./mcp/serve.tsx");
        return builder(y);
      },
      async (argv: any) => {
        const { handler } = await import("./mcp/serve.tsx");
        return handler(argv);
      },
    )
    .demandCommand();
};
