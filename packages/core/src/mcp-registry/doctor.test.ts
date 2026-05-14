import { createStubPlatformModels } from "@atlas/llm";
import { describe, it, vi } from "vitest";
import { buildDoctorPrompt, runDoctor } from "./doctor.ts";
import type { UpstreamServerEntry } from "./upstream-client.ts";

function makeEntry(name = "io.example/test-server"): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://example.com/schema.json",
      name,
      description: "A test MCP server",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/test-server",
          version: "1.0.0",
          transport: { type: "stdio" },
        },
      ],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-01-01T00:00:00.000000Z",
        publishedAt: "2025-01-01T00:00:00.000000Z",
        updatedAt: "2025-01-01T00:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** A mocked `generateObject` that resolves with the given raw LLM object. */
function mockGenerate(object: unknown) {
  return vi
    .fn<(...args: unknown[]) => Promise<{ object: unknown }>>()
    .mockResolvedValue({ object });
}

const CREDENTIAL_README = `# Bitbucket MCP

## Configuration
Set these environment variables before running:
- \`BITBUCKET_USERNAME\` — your Bitbucket username (required)
- \`BITBUCKET_APP_PASSWORD\` — an app password (required, keep secret)
- \`BITBUCKET_WORKSPACE\` — the workspace slug (required)
`;

const SELF_CONTAINED_README = `# Calculator MCP

A simple arithmetic server. No configuration, no credentials — install and run.
`;

const SPARSE_README = `# Some Server

Configure your credentials and you're good to go.
`;

describe("runDoctor", () => {
  it("credential-heavy README → attention with every name verbatim-verified", async ({
    expect,
  }) => {
    const generateObject = mockGenerate({
      verdict: "attention",
      tldr: "Bitbucket MCP needs three credentials before it can run.",
      findings: [],
      env_vars: [
        {
          name: "BITBUCKET_USERNAME",
          description: "Bitbucket username",
          isRequired: true,
          isSecret: false,
          readme_excerpt: "BITBUCKET_USERNAME — your Bitbucket username",
        },
        {
          name: "BITBUCKET_APP_PASSWORD",
          description: "App password",
          isRequired: true,
          isSecret: true,
          readme_excerpt: "BITBUCKET_APP_PASSWORD — an app password",
        },
        {
          name: "BITBUCKET_WORKSPACE",
          description: "Workspace slug",
          isRequired: true,
          isSecret: false,
          readme_excerpt: "BITBUCKET_WORKSPACE — the workspace slug",
        },
      ],
    });

    const report = await runDoctor({
      registryEntry: makeEntry(),
      readme: CREDENTIAL_README,
      platformModels: createStubPlatformModels(),
      generateObject,
    });

    expect(report.verdict).toBe("attention");
    if (report.verdict !== "attention") return;
    expect(report.env_vars).toHaveLength(3);
    for (const ev of report.env_vars) {
      expect(CREDENTIAL_README).toContain(ev.name);
      expect(ev.provenance.source).toBe("friday");
    }
  });

  it("self-contained README → clean with no env_vars field at all", async ({ expect }) => {
    const generateObject = mockGenerate({
      verdict: "clean",
      tldr: "A self-contained calculator server — install and run.",
      findings: [],
    });

    const report = await runDoctor({
      registryEntry: makeEntry(),
      readme: SELF_CONTAINED_README,
      platformModels: createStubPlatformModels(),
      generateObject,
    });

    expect(report.verdict).toBe("clean");
    expect("env_vars" in report).toBe(false);
  });

  it("sparse README → unknown with at least one finding", async ({ expect }) => {
    const generateObject = mockGenerate({
      verdict: "unknown",
      tldr: "This server mentions credentials but does not enumerate them.",
      findings: [
        {
          severity: "warn",
          title: "Credentials referenced but not enumerated",
          detail: "The README says to configure credentials but lists no variable names.",
        },
      ],
    });

    const report = await runDoctor({
      registryEntry: makeEntry(),
      readme: SPARSE_README,
      platformModels: createStubPlatformModels(),
      generateObject,
    });

    expect(report.verdict).toBe("unknown");
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it("drops a hallucinated env var name not present in the source text", async ({ expect }) => {
    const generateObject = mockGenerate({
      verdict: "attention",
      tldr: "Needs one credential.",
      findings: [],
      env_vars: [
        {
          name: "BITBUCKET_USERNAME",
          isRequired: true,
          isSecret: false,
          readme_excerpt: "BITBUCKET_USERNAME — your Bitbucket username",
        },
        {
          name: "TOTALLY_INVENTED_VAR",
          isRequired: true,
          isSecret: true,
          readme_excerpt: "fabricated excerpt",
        },
      ],
    });

    const report = await runDoctor({
      registryEntry: makeEntry(),
      readme: CREDENTIAL_README,
      platformModels: createStubPlatformModels(),
      generateObject,
    });

    expect(report.verdict).toBe("attention");
    if (report.verdict !== "attention") return;
    expect(report.env_vars.map((e) => e.name)).toEqual(["BITBUCKET_USERNAME"]);
    expect(report.findings.some((f) => f.title === "Dropped unverifiable env vars")).toBe(true);
  });

  it("downgrades attention → unknown when every env var fails verification", async ({ expect }) => {
    const generateObject = mockGenerate({
      verdict: "attention",
      tldr: "Claims to need credentials.",
      findings: [],
      env_vars: [
        { name: "FAKE_ONE", isRequired: true, isSecret: false, readme_excerpt: "made up" },
        { name: "FAKE_TWO", isRequired: true, isSecret: true, readme_excerpt: "also made up" },
      ],
    });

    const report = await runDoctor({
      registryEntry: makeEntry(),
      readme: SELF_CONTAINED_README,
      platformModels: createStubPlatformModels(),
      generateObject,
    });

    expect(report.verdict).toBe("unknown");
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it("never throws — a thrown LLM error collapses to unknown with an error finding", async ({
    expect,
  }) => {
    const generateObject = vi
      .fn<(...args: unknown[]) => Promise<{ object: unknown }>>()
      .mockRejectedValue(new Error("LLM exploded"));

    const report = await runDoctor({
      registryEntry: makeEntry(),
      readme: CREDENTIAL_README,
      platformModels: createStubPlatformModels(),
      generateObject,
    });

    expect(report.verdict).toBe("unknown");
    expect(
      report.findings.some((f) => f.severity === "error" && f.detail.includes("LLM exploded")),
    ).toBe(true);
  });
});

describe("buildDoctorPrompt", () => {
  it("weaves curator doctor-notes into the prompt as an authoritative section", ({ expect }) => {
    const prompt = buildDoctorPrompt(
      makeEntry(),
      SELF_CONTAINED_README,
      "Use the OAuth flow — the API key path is deprecated upstream.",
    );

    expect(prompt).toContain("Curator notes");
    expect(prompt).toContain("Use the OAuth flow — the API key path is deprecated upstream.");
  });

  it("omits the curator section when no doctor-notes are provided", ({ expect }) => {
    const prompt = buildDoctorPrompt(makeEntry(), SELF_CONTAINED_README);

    expect(prompt).not.toContain("Curator notes");
  });

  it("includes the registry entry and README in the prompt", ({ expect }) => {
    const prompt = buildDoctorPrompt(makeEntry("io.example/widget"), CREDENTIAL_README);

    expect(prompt).toContain("io.example/widget");
    expect(prompt).toContain("BITBUCKET_USERNAME");
  });
});
