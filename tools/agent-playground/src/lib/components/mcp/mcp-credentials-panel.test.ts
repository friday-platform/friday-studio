// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "svelte";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";

// Mock TanStack Query so .svelte imports from node_modules don't break node tests
vi.mock("@tanstack/svelte-query", () => ({
  createQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isPending: false,
    error: null,
  })),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

// Mock useCredentialConnect rune
vi.mock("../../use-credential-connect.svelte.ts", () => ({
  useCredentialConnect: vi.fn(() => ({
    popupBlocked: false,
    blockedUrl: null,
    submitting: false,
    error: null,
    startOAuth: vi.fn(),
    startAppInstall: vi.fn(),
    listenForCallback: vi.fn(() => vi.fn()),
    submitApiKey: vi.fn(),
  })),
}));

// Mock link-provider-queries
vi.mock("../../queries/link-provider-queries.ts", () => ({
  linkProviderQueries: {
    all: () => ["daemon", "link", "providers"],
    providerDetails: (id: string) => ({ queryKey: ["details", id] }),
    credentialsByProvider: (id: string) => ({ queryKey: ["credentials", id] }),
  },
}));

// Mock link-credentials mutations
vi.mock("../../queries/link-credentials.ts", () => ({
  useDeleteCredential: vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useUpdateCredentialSecret: vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  })),
}));

const { default: McpCredentialsPanel } = await import("./mcp-credentials-panel.svelte");

function createContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function removeContainer(el: HTMLElement) {
  el.remove();
}

describe("McpCredentialsPanel — rendering", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = createContainer();
  });

  afterEach(() => {
    removeContainer(container);
  });

  it("renders nothing when configTemplate has no env", () => {
    const configTemplate: MCPServerMetadata["configTemplate"] = {
      transport: { type: "stdio", command: "echo" },
    };

    mount(McpCredentialsPanel, {
      target: container,
      props: { serverId: "test-server", configTemplate },
    });

    expect(container.querySelector(".credentials-panel")).toBeNull();
  });

  it("renders panel when env contains a LinkCredentialRef with provider", () => {
    const configTemplate: MCPServerMetadata["configTemplate"] = {
      transport: { type: "stdio", command: "echo" },
      env: {
        API_KEY: { from: "link", provider: "openai", key: "apiKey" },
      },
    };

    mount(McpCredentialsPanel, {
      target: container,
      props: { serverId: "test-server", configTemplate },
    });

    expect(container.querySelector(".credentials-panel")).not.toBeNull();
  });

  it("shows id-based ref notice when env contains only id-based refs", () => {
    const configTemplate: MCPServerMetadata["configTemplate"] = {
      transport: { type: "stdio", command: "echo" },
      env: {
        TOKEN: { from: "link", id: "cred-123", key: "access_token" },
      },
    };

    mount(McpCredentialsPanel, {
      target: container,
      props: { serverId: "test-server", configTemplate },
    });

    expect(container.querySelector(".id-ref-notice")).not.toBeNull();
    expect(container.textContent).toContain("Settings");
  });

  it("renders provider section for each unique provider in env", () => {
    const configTemplate: MCPServerMetadata["configTemplate"] = {
      transport: { type: "stdio", command: "echo" },
      env: {
        KEY1: { from: "link", provider: "openai", key: "apiKey" },
        KEY2: { from: "link", provider: "github", key: "access_token" },
      },
    };

    mount(McpCredentialsPanel, {
      target: container,
      props: { serverId: "test-server", configTemplate },
    });

    const sections = container.querySelectorAll(".provider-section");
    expect(sections.length).toBe(2);
  });
});
