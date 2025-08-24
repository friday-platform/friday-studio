import { assertEquals } from "@std/assert";

// Parse command arguments while preserving complex arguments
const parseSlashCommand = (input: string) => {
  if (!input.startsWith("/")) {
    return null;
  }

  const trimmed = input.slice(1).trim();
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;
  let i = 0;

  while (i < trimmed.length) {
    const char = trimmed[i];

    if (char === '"' && braceDepth === 0) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "{") {
      braceDepth++;
      current += char;
    } else if (char === "}") {
      braceDepth--;
      current += char;
    } else if (char === " " && !inQuotes && braceDepth === 0) {
      if (current.trim()) {
        args.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  if (args.length === 0) {
    return null;
  }

  return { command: args[0].toLowerCase(), args: args.slice(1), rawInput: input };
};

Deno.test("parseSlashCommand - Basic command parsing", () => {
  const result = parseSlashCommand("/help");
  assertEquals(result, { command: "help", args: [], rawInput: "/help" });
});

Deno.test("parseSlashCommand - Command with single argument", () => {
  const result = parseSlashCommand("/signal list");
  assertEquals(result, { command: "signal", args: ["list"], rawInput: "/signal list" });
});

Deno.test("parseSlashCommand - Command with multiple arguments", () => {
  const result = parseSlashCommand("/signal trigger webhook-handler");
  assertEquals(result, {
    command: "signal",
    args: ["trigger", "webhook-handler"],
    rawInput: "/signal trigger webhook-handler",
  });
});

Deno.test("parseSlashCommand - Command with quoted arguments", () => {
  const result = parseSlashCommand('/signal trigger "my signal" "another arg"');
  assertEquals(result, {
    command: "signal",
    args: ["trigger", '"my signal"', '"another arg"'],
    rawInput: '/signal trigger "my signal" "another arg"',
  });
});

Deno.test("parseSlashCommand - Command with JSON object", () => {
  const result = parseSlashCommand('/signal trigger webhook {"event": "deploy", "user": "john"}');
  assertEquals(result, {
    command: "signal",
    args: ["trigger", "webhook", '{"event": "deploy", "user": "john"}'],
    rawInput: '/signal trigger webhook {"event": "deploy", "user": "john"}',
  });
});

Deno.test("parseSlashCommand - Command with nested JSON object", () => {
  const result = parseSlashCommand(
    '/signal trigger webhook {"data": {"nested": {"value": 123}}, "meta": "info"}',
  );
  assertEquals(result, {
    command: "signal",
    args: ["trigger", "webhook", '{"data": {"nested": {"value": 123}}, "meta": "info"}'],
    rawInput: '/signal trigger webhook {"data": {"nested": {"value": 123}}, "meta": "info"}',
  });
});

Deno.test("parseSlashCommand - Command with JSON array", () => {
  const result = parseSlashCommand('/config set agents ["agent1", "agent2", "agent3"]');
  assertEquals(result, {
    command: "config",
    args: ["set", "agents", '["agent1",', '"agent2",', '"agent3"]'],
    rawInput: '/config set agents ["agent1", "agent2", "agent3"]',
  });
});

Deno.test("parseSlashCommand - Command with mixed quotes and JSON", () => {
  const result = parseSlashCommand(
    '/signal trigger "my-signal" {"message": "hello world", "count": 42}',
  );
  assertEquals(result, {
    command: "signal",
    args: ["trigger", '"my-signal"', '{"message": "hello world", "count": 42}'],
    rawInput: '/signal trigger "my-signal" {"message": "hello world", "count": 42}',
  });
});

Deno.test("parseSlashCommand - Command case insensitive", () => {
  const result = parseSlashCommand("/HELP");
  assertEquals(result, { command: "help", args: [], rawInput: "/HELP" });
});

Deno.test("parseSlashCommand - Command with extra whitespace", () => {
  const result = parseSlashCommand("/  signal   list   ");
  assertEquals(result, { command: "signal", args: ["list"], rawInput: "/  signal   list   " });
});

Deno.test("parseSlashCommand - Non-slash input returns null", () => {
  const result = parseSlashCommand("help");
  assertEquals(result, null);
});

Deno.test("parseSlashCommand - Empty slash command returns null", () => {
  const result = parseSlashCommand("/");
  assertEquals(result, null);
});

Deno.test("parseSlashCommand - Slash with only whitespace returns null", () => {
  const result = parseSlashCommand("/   ");
  assertEquals(result, null);
});

Deno.test("parseSlashCommand - Complex JSON with quotes inside", () => {
  const result = parseSlashCommand(
    '/signal trigger webhook {"message": "User said: \\"hello\\"", "status": "active"}',
  );
  assertEquals(result, {
    command: "signal",
    args: ["trigger", "webhook", '{"message": "User said: \\"hello\\"", "status": "active"}'],
    rawInput: '/signal trigger webhook {"message": "User said: \\"hello\\"", "status": "active"}',
  });
});

Deno.test("parseSlashCommand - JSON with spaces in values", () => {
  const result = parseSlashCommand(
    '/signal trigger webhook {"event type": "deployment completed", "environment": "production"}',
  );
  assertEquals(result, {
    command: "signal",
    args: [
      "trigger",
      "webhook",
      '{"event type": "deployment completed", "environment": "production"}',
    ],
    rawInput:
      '/signal trigger webhook {"event type": "deployment completed", "environment": "production"}',
  });
});

Deno.test("parseSlashCommand - Multiple JSON objects", () => {
  const result = parseSlashCommand(
    '/config merge {"defaults": {"timeout": 30}} {"overrides": {"retries": 3}}',
  );
  assertEquals(result, {
    command: "config",
    args: ["merge", '{"defaults": {"timeout": 30}}', '{"overrides": {"retries": 3}}'],
    rawInput: '/config merge {"defaults": {"timeout": 30}} {"overrides": {"retries": 3}}',
  });
});

Deno.test("parseSlashCommand - Empty JSON object", () => {
  const result = parseSlashCommand("/signal trigger webhook {}");
  assertEquals(result, {
    command: "signal",
    args: ["trigger", "webhook", "{}"],
    rawInput: "/signal trigger webhook {}",
  });
});

Deno.test("parseSlashCommand - JSON with boolean and null values", () => {
  const result = parseSlashCommand(
    '/signal trigger webhook {"enabled": true, "data": null, "debug": false}',
  );
  assertEquals(result, {
    command: "signal",
    args: ["trigger", "webhook", '{"enabled": true, "data": null, "debug": false}'],
    rawInput: '/signal trigger webhook {"enabled": true, "data": null, "debug": false}',
  });
});

Deno.test("parseSlashCommand - Quoted argument with spaces", () => {
  const result = parseSlashCommand('/agent describe "my long agent name"');
  assertEquals(result, {
    command: "agent",
    args: ["describe", '"my long agent name"'],
    rawInput: '/agent describe "my long agent name"',
  });
});

Deno.test("parseSlashCommand - Mixed arguments types", () => {
  const result = parseSlashCommand('/command arg1 "quoted arg" {"json": "object"} final-arg');
  assertEquals(result, {
    command: "command",
    args: ["arg1", '"quoted arg"', '{"json": "object"}', "final-arg"],
    rawInput: '/command arg1 "quoted arg" {"json": "object"} final-arg',
  });
});
