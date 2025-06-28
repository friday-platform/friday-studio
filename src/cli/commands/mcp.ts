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
    .demandCommand(1)
    .fail((msg: string, _: unknown, yargs: any) => {
      if (msg && msg.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        Deno.exit(0);
      }
      yargs.showHelp();
      console.error("\n" + msg);
      Deno.exit(1);
    })
    .help()
    .alias("help", "h");
};
