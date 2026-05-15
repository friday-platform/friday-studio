import { homedir } from "node:os";
import process from "node:process";

/**
 * Expand `~`, `$HOME` / `${HOME}`, and `$USER` / `${USER}` in a user-supplied
 * path before the fs tools resolve it.
 *
 * Without this the fs tools treat a leading `~` as a literal directory name
 * (it is not `path.isAbsolute`), so `~/repo/file.ts` resolves to
 * `<daemon-cwd>/~/repo/file.ts` instead of the home directory — a frequent
 * agent failure mode when touching files outside the workspace. After
 * expansion the path is absolute, so each tool's normal `isAbsolute` branch
 * honors it; ordinary relative paths (`src/foo.ts`) are returned unchanged.
 */
export function expandUserPath(inputPath: string): string {
  const home = process.env.HOME ?? homedir();
  let out = inputPath;

  // Leading tilde only — `~` → home, `~/x` → home/x. A bare `~name` (a literal
  // entry that merely starts with a tilde) is left untouched.
  if (out === "~") {
    out = home;
  } else if (out.startsWith("~/")) {
    out = home + out.slice(1);
  }

  // `$HOME` / `${HOME}` / `$USER` / `${USER}`, word-boundaried so `$HOMEBREW`
  // and similar are never partially expanded.
  out = out.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
  const user = process.env.USER;
  if (user) {
    out = out.replace(/\$\{USER\}|\$USER(?![A-Za-z0-9_])/g, user);
  }
  return out;
}
