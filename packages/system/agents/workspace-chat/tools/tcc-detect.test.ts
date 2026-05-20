import process from "node:process";
import { describe, expect, it } from "vitest";
import { detectTccDenial } from "./tcc-detect.ts";

const HOME = "/Users/friday";

/**
 * The detector branches on `process.platform === "darwin"`. Wrap each
 * darwin-specific assertion so non-mac CI still passes — the helper is
 * shared but its activation is OS-specific by design.
 */
function darwinOnly(name: string, body: () => void | Promise<void>) {
  it(name, async () => {
    if (process.platform !== "darwin") return;
    await body();
  });
}

describe("detectTccDenial — recognised macOS error signatures", () => {
  darwinOnly("recognises `find: <path>: Operation not permitted`", () => {
    const out = "find: /Users/friday/Downloads/bucketlist-cs/agents: Operation not permitted\n";
    const result = detectTccDenial(out, HOME);
    expect(result).not.toBeNull();
    expect(result?.protectedRoot).toBe("/Users/friday/Downloads");
    expect(result?.attemptedPath).toBe("/Users/friday/Downloads/bucketlist-cs/agents");
  });

  darwinOnly("recognises `ls: <path>/: Operation not permitted` (trailing slash)", () => {
    const out = "ls: /Users/friday/Downloads/: Operation not permitted\ntotal 0\n";
    const result = detectTccDenial(out, HOME);
    expect(result).not.toBeNull();
    expect(result?.attemptedPath).toBe("/Users/friday/Downloads");
  });

  darwinOnly("recognises Python PermissionError with quoted path", () => {
    const out = "PermissionError: [Errno 1] Operation not permitted: '/Users/friday/Downloads'\n";
    const result = detectTccDenial(out, HOME);
    expect(result).not.toBeNull();
    expect(result?.attemptedPath).toBe("/Users/friday/Downloads");
  });

  darwinOnly("recognises Desktop and Documents, not just Downloads", () => {
    const desk = detectTccDenial("ls: /Users/friday/Desktop/foo: Operation not permitted", HOME);
    const docs = detectTccDenial("ls: /Users/friday/Documents/foo: Operation not permitted", HOME);
    expect(desk?.protectedRoot).toBe("/Users/friday/Desktop");
    expect(docs?.protectedRoot).toBe("/Users/friday/Documents");
  });

  darwinOnly("emits two actions: System Settings deeplink + copy-shell mv suggestion", () => {
    const out = "find: /Users/friday/Downloads/bucketlist-cs: Operation not permitted";
    const result = detectTccDenial(out, HOME);
    expect(result?.actions).toHaveLength(2);
    expect(result?.actions[0]).toMatchObject({
      type: "open-url",
      payload: expect.stringContaining("Privacy_Files_Folders"),
    });
    expect(result?.actions[1]).toMatchObject({
      type: "copy-shell",
      payload: expect.stringContaining("mv "),
    });
    // The suggested mv destination should be under $HOME, not under Downloads.
    expect(result?.actions[1].payload).toContain("/Users/friday/bucketlist-cs");
  });

  darwinOnly("shell-quotes paths with spaces in the mv suggestion", () => {
    const out = "ls: /Users/friday/Downloads/folder with spaces: Operation not permitted";
    const result = detectTccDenial(out, HOME);
    expect(result?.actions[1].payload).toContain(`'/Users/friday/Downloads/folder with spaces'`);
    expect(result?.actions[1].payload).toContain(`'/Users/friday/folder with spaces'`);
  });

  darwinOnly("drops the no-op mv suggestion when user attempted the root itself", () => {
    // Real repro from QA 2026-05-19: user runs `ls -la ~/Downloads`. Without
    // this guard the suggestion becomes `mv '~/Downloads' '~/Downloads'` —
    // a no-op and a confusing one. Only the System Settings deeplink stays.
    const out = "ls: /Users/friday/Downloads: Operation not permitted";
    const result = detectTccDenial(out, HOME);
    expect(result?.attemptedPath).toBe("/Users/friday/Downloads");
    expect(result?.actions).toHaveLength(1);
    expect(result?.actions[0].type).toBe("open-url");
  });
});

describe("detectTccDenial — non-matches", () => {
  darwinOnly("returns null when stdout is empty", () => {
    expect(detectTccDenial("", HOME)).toBeNull();
  });

  darwinOnly("returns null when 'Operation not permitted' is not present", () => {
    expect(detectTccDenial("ls: /tmp/foo: No such file or directory", HOME)).toBeNull();
  });

  darwinOnly("returns null when the path is outside the protected dirs", () => {
    // ~/.friday/local/scratch is not TCC-protected; a permission error here
    // is a real ACL bug and we should NOT swallow it with a fake TCC card.
    const out = "ls: /Users/friday/.friday/local/scratch/foo: Operation not permitted";
    expect(detectTccDenial(out, HOME)).toBeNull();
  });

  darwinOnly("returns null when the path is under a different user's home", () => {
    const out = "ls: /Users/other/Downloads/foo: Operation not permitted";
    expect(detectTccDenial(out, HOME)).toBeNull();
  });
});

describe("detectTccDenial — platform gate", () => {
  it("returns null on non-darwin platforms even with a matching string", () => {
    if (process.platform === "darwin") return;
    // On Linux/Windows, an "Operation not permitted" error against a path
    // that LOOKS like a Mac home is a real chmod/ACL issue — we must NOT
    // surface a misleading "grant macOS permission" affordance.
    const out = "find: /Users/friday/Downloads/foo: Operation not permitted";
    expect(detectTccDenial(out, HOME)).toBeNull();
  });
});
