/**
 * Tests for terminal setup module
 */

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  detectTerminal,
  getTerminalContext,
  isScreenSession,
  isSSHSession,
  isTmuxSession,
} from "../detector.ts";
import { preFlightCheck } from "../index.ts";
import {
  formatErrorMessage,
  formatInfoMessage,
  formatSuccessMessage,
  formatWarningMessage,
  isCI,
} from "../utils.ts";

describe("Terminal Detection", () => {
  it("should detect platform support", async () => {
    const terminal = await detectTerminal();
    assertExists(terminal);
    assertEquals(typeof terminal.isSupported, "boolean");
    assertExists(terminal.confidence);
    assertExists(terminal.detectionMethod);
  });

  it("should return unsupported for non-macOS platforms", async () => {
    // This test will only pass on non-macOS platforms
    if (Deno.build.os !== "darwin") {
      const terminal = await detectTerminal();
      assertEquals(terminal.isSupported, false);
      assertEquals(terminal.type, "unknown");
    }
  });

  it("should detect SSH session", () => {
    // Save original env
    const originalSSHClient = Deno.env.get("SSH_CLIENT");
    const originalSSHTTY = Deno.env.get("SSH_TTY");

    // Test with SSH_CLIENT
    Deno.env.set("SSH_CLIENT", "192.168.1.1 22 192.168.1.2 22");
    assertEquals(isSSHSession(), true);
    Deno.env.delete("SSH_CLIENT");

    // Test with SSH_TTY
    Deno.env.set("SSH_TTY", "/dev/pts/0");
    assertEquals(isSSHSession(), true);
    Deno.env.delete("SSH_TTY");

    // Test without SSH
    assertEquals(isSSHSession(), false);

    // Restore original env
    if (originalSSHClient) Deno.env.set("SSH_CLIENT", originalSSHClient);
    if (originalSSHTTY) Deno.env.set("SSH_TTY", originalSSHTTY);
  });

  it("should detect tmux session", () => {
    const originalTmux = Deno.env.get("TMUX");

    Deno.env.set("TMUX", "/tmp/tmux-1000/default,1234,0");
    assertEquals(isTmuxSession(), true);

    Deno.env.delete("TMUX");
    assertEquals(isTmuxSession(), false);

    if (originalTmux) Deno.env.set("TMUX", originalTmux);
  });

  it("should detect screen session", () => {
    const originalSTY = Deno.env.get("STY");

    Deno.env.set("STY", "1234.pts-0.hostname");
    assertEquals(isScreenSession(), true);

    Deno.env.delete("STY");
    assertEquals(isScreenSession(), false);

    if (originalSTY) Deno.env.set("STY", originalSTY);
  });

  it("should get comprehensive terminal context", async () => {
    const context = await getTerminalContext();
    assertExists(context.terminal);
    assertEquals(typeof context.isSSH, "boolean");
    assertEquals(typeof context.isTmux, "boolean");
    assertEquals(typeof context.isScreen, "boolean");
    assertEquals(typeof context.isDocker, "boolean");
    assertEquals(Array.isArray(context.warnings), true);
  });
});

describe("Utility Functions", () => {
  it("should format success messages", () => {
    const message = formatSuccessMessage("Test success");
    assertEquals(message, "✅ Test success");
  });

  it("should format error messages", () => {
    const message = formatErrorMessage("Test error");
    assertEquals(message, "❌ Test error");
  });

  it("should format warning messages", () => {
    const message = formatWarningMessage("Test warning");
    assertEquals(message, "⚠️  Test warning");
  });

  it("should format info messages", () => {
    const message = formatInfoMessage("Test info");
    assertEquals(message, "ℹ️  Test info");
  });
});

describe("Pre-flight Checks", () => {
  it("should perform pre-flight checks", async () => {
    const result = await preFlightCheck();
    assertExists(result);
    assertEquals(typeof result.canProceed, "boolean");
    assertEquals(Array.isArray(result.issues), true);
    assertEquals(Array.isArray(result.warnings), true);
  });

  it("should fail in CI environment", async () => {
    const originalCI = Deno.env.get("CI");

    Deno.env.set("CI", "true");
    const result = await preFlightCheck();
    assertEquals(result.canProceed, false);
    assertEquals(result.issues.includes("Cannot configure terminal in CI environment"), true);

    Deno.env.delete("CI");
    if (originalCI) Deno.env.set("CI", originalCI);
  });

  it("should check platform support", async () => {
    const result = await preFlightCheck();

    if (Deno.build.os !== "darwin") {
      assertEquals(result.canProceed, false);
      const hasPlatformIssue = result.issues.some((issue) =>
        issue.includes("is not supported - only macOS (darwin) is supported"),
      );
      assertEquals(hasPlatformIssue, true);
    }
  });
});
