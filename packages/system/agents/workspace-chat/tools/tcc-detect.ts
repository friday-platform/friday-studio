/**
 * macOS TCC (Transparency, Consent, and Control) denial detector.
 *
 * macOS gates `~/Downloads`, `~/Desktop`, and `~/Documents` behind a per-app
 * permission grant. When Friday Studio (and therefore the daemon and every
 * `run_code` shell it spawns) lacks that grant, every `ls`, `find`, `open`,
 * `read`, etc. against those folders fails with `Operation not permitted` —
 * a generic POSIX errno that gives the LLM no useful repair signal. Without
 * this detector the agent dumps the raw error and asks the user to debug it.
 *
 * The detector turns that into a structured affordance the chat UI renders
 * as a card with a deeplink to System Settings → Privacy & Security → Files
 * & Folders, where the user can flip the toggle in one click.
 *
 * Scope: macOS only. On Linux, "Operation not permitted" usually means a
 * real filesystem ACL or chmod issue and the user wants to see it raw.
 */

import { homedir } from "node:os";
import process from "node:process";

/**
 * The TCC-protected user folders we recognise. Three is the canonical macOS
 * "user files" set; iCloud Drive and removable volumes are gated separately
 * (and are rare enough in normal Friday usage that we don't try to detect
 * them here — false negatives there fall back to the raw error, which is
 * the same behavior we have today).
 */
const TCC_PROTECTED_DIRS = ["Downloads", "Desktop", "Documents"] as const;

/** macOS deeplink that opens System Settings → Privacy & Security → Files & Folders. */
const FILES_AND_FOLDERS_DEEPLINK =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Files_Folders";

export interface TccDeniedAction {
  /** Visible button label. */
  label: string;
  /**
   * `open-url` opens the URL via the OS handler (System Settings deeplink).
   * `copy-shell` copies a suggested shell command to the clipboard.
   */
  type: "open-url" | "copy-shell";
  /** URL when `type === "open-url"`, shell command when `type === "copy-shell"`. */
  payload: string;
}

export interface TccDenial {
  kind: "tcc-denied";
  /** The TCC-protected root that triggered the denial, e.g. `/Users/lcf/Downloads`. */
  protectedRoot: string;
  /** The full path the daemon tried to access. */
  attemptedPath: string;
  /** Short user-facing explanation. The chat UI renders this verbatim. */
  guidance: string;
  /** One or more click-actions the user can take to unblock. */
  actions: TccDeniedAction[];
}

/**
 * Inspect a combined stdout/stderr string for the macOS TCC denial signature
 * against one of the protected user folders. Returns null on Linux/Windows,
 * when the marker isn't present, or when the path doesn't match a protected
 * root.
 *
 * `homeDir` is injected so tests can pin a deterministic home — production
 * callers pass {@link homedir}().
 */
export function detectTccDenial(combined: string, homeDir: string = homedir()): TccDenial | null {
  if (process.platform !== "darwin") return null;
  if (!combined.includes("Operation not permitted")) return null;

  for (const dir of TCC_PROTECTED_DIRS) {
    const root = `${homeDir}/${dir}`;
    // Find any line containing both "Operation not permitted" and the
    // protected root, then extract the longest path under that root.
    // Two error orderings exist in the wild:
    //   `find: <path>: Operation not permitted`            (path first)
    //   `ls: <path>/: Operation not permitted`             (path first)
    //   `PermissionError: [Errno 1] Operation not permitted: '<path>'`
    //                                                       (path last)
    // The pattern must stop at quotes / whitespace / the colon-terminator,
    // but allow normal path characters including spaces.
    const candidate = combined
      .split(/\r?\n/)
      .find((line) => line.includes("Operation not permitted") && line.includes(root));
    if (!candidate) continue;

    const pathRe = new RegExp(`${escapeRegExp(root)}[^'"\\n:]*`);
    const pathMatch = candidate.match(pathRe);
    if (!pathMatch) continue;

    // Trim trailing whitespace and slashes, but keep at least the protected
    // root if everything after it was empty.
    const attemptedPath = pathMatch[0].replace(/[\s/]+$/, "") || root;
    const actions: TccDeniedAction[] = [
      { label: "Open System Settings", type: "open-url", payload: FILES_AND_FOLDERS_DEEPLINK },
    ];
    // Only suggest a move when the user accessed something *under* the
    // protected root. When the attempted path IS the root itself (e.g.
    // `ls ~/Downloads`), `mv` would be a no-op (`mv ~/Downloads ~/Downloads`)
    // and offering it is just noise.
    if (attemptedPath !== root) {
      actions.push({
        label: `Move out of ~/${dir}`,
        type: "copy-shell",
        payload: `mv ${shellQuote(attemptedPath)} ${shellQuote(`${homeDir}/${basename(attemptedPath)}`)}`,
      });
    }
    return {
      kind: "tcc-denied",
      protectedRoot: root,
      attemptedPath,
      guidance: `Friday Studio doesn't have macOS permission to read ~/${dir}. Grant it in System Settings → Privacy & Security → Files & Folders, then retry.`,
      actions,
    };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(s: string): string {
  // Single-quote and escape any embedded single quotes the POSIX way.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
