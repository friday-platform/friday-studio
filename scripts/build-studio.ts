#!/usr/bin/env -S deno run -A
/**
 * Builds a Friday Studio platform artifact for one target triple.
 *
 * Usage:
 *   deno run -A scripts/build-studio.ts \
 *     --target aarch64-apple-darwin \
 *     --version 0.0.1
 *
 * Produces:
 *   dist/friday-studio_<version>_<target>.<tar.gz|zip>   (the archive)
 *   dist/friday-studio_<version>_<target>.<ext>.sha256   (sidecar)
 *   dist/friday-studio_<version>_<target>.json          (manifest entry)
 *
 * Targets supported:
 *   aarch64-apple-darwin       (macOS Apple Silicon, tar.gz)
 *   x86_64-apple-darwin        (macOS Intel,        tar.gz)
 *   x86_64-pc-windows-msvc     (Windows x64,        zip)
 *
 * For each target the script:
 *   1. `deno compile`s atlas, link, webhook-tunnel, playground.
 *   2. Downloads pinned external CLIs (gh, cloudflared) for the target.
 *   3. Stages everything under dist/<target>/staging/.
 *   4. Archives the staging dir + emits sha256 + size.
 *
 * Codesigning, notarization, and GCS upload are NOT done here — they live in
 * the surrounding GitHub Actions workflow that calls this script.
 */
import { parseArgs } from "jsr:@std/cli@^1.0.6/parse-args";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CliFlags {
  target: string;
  version: string;
  outDir: string;
  skipCompile: boolean;
  skipExternal: boolean;
}

interface ExternalCliPin {
  name: string;
  version: string;
  url: (target: string) => string;
  /** Path inside the downloaded archive (or "" if it IS the binary). */
  innerPath: (target: string) => string;
  /** Final output filename in the staging tree. */
  outName: (target: string) => string;
}

/** A bundle is a directory tree (e.g. Node's full distribution) extracted
 * verbatim into a subdirectory of the staging tree. Single-file pins go
 * through ExternalCliPin; trees go through this. The archive's top-level
 * directory (e.g. node-v24.15.0-darwin-arm64/) is stripped during extract
 * so the staged contents land flat under outDir. */
interface ExternalBundlePin {
  name: string;
  version: string;
  url: (target: string) => string;
  /** Top-level directory inside the archive that we strip on extract. */
  archiveRoot: (target: string) => string;
  /** Subdirectory of staging where the contents land. */
  outDir: string;
  /** URL of a SHASUMS256-style file. The lookup key is the asset filename
   * (last URL segment); the matching line's hex digest is verified before
   * extraction. */
  shasumsUrl: (target: string) => string;
}

const GH_VERSION = "2.92.0";
const CLOUDFLARED_VERSION = "2026.3.0";
const NATS_SERVER_VERSION = "2.12.8";
const UV_VERSION = "0.11.8";
const NODE_VERSION = "24.15.0";
const AGENT_BROWSER_VERSION = "0.26.0";

const EXTERNAL_CLIS: readonly ExternalCliPin[] = [
  {
    name: "gh",
    version: GH_VERSION,
    url: (t) => {
      const map: Record<string, string> = {
        "aarch64-apple-darwin": `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_arm64.zip`,
        "x86_64-apple-darwin": `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_amd64.zip`,
        "x86_64-pc-windows-msvc": `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_windows_amd64.zip`,
      };
      const url = map[t];
      if (!url) throw new Error(`gh: unsupported target ${t}`);
      return url;
    },
    innerPath: (t) => {
      // Layout differs between zips: macOS releases nest under
      // `gh_<v>_macOS_<arch>/`, Windows releases unzip flat with just
      // `bin/gh.exe` at the root.
      if (t.endsWith("windows-msvc")) return "bin/gh.exe";
      const arch = t.startsWith("aarch64") ? "arm64" : "amd64";
      return `gh_${GH_VERSION}_macOS_${arch}/bin/gh`;
    },
    outName: (t) => (t.endsWith("windows-msvc") ? "gh.exe" : "gh"),
  },
  {
    name: "cloudflared",
    version: CLOUDFLARED_VERSION,
    url: (t) => {
      const map: Record<string, string> = {
        "aarch64-apple-darwin": `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`,
        "x86_64-apple-darwin": `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz`,
        "x86_64-pc-windows-msvc": `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
      };
      const url = map[t];
      if (!url) throw new Error(`cloudflared: unsupported target ${t}`);
      return url;
    },
    innerPath: (t) => (t.endsWith("windows-msvc") ? "" : "cloudflared"),
    outName: (t) => (t.endsWith("windows-msvc") ? "cloudflared.exe" : "cloudflared"),
  },
  {
    // friday-launcher supervises nats-server as a sibling process so
    // atlasd can connect to it via tcpProbe rather than spawning its
    // own internal copy. ~6 MB per platform; native release tarballs
    // from nats-io/nats-server. macOS releases nest the binary under
    // `nats-server-v<version>-darwin-<arch>/nats-server`; Windows zip
    // does the same with `\nats-server-v<version>-windows-amd64\nats-server.exe`.
    name: "nats-server",
    version: NATS_SERVER_VERSION,
    url: (t) => {
      const map: Record<string, string> = {
        "aarch64-apple-darwin": `https://github.com/nats-io/nats-server/releases/download/v${NATS_SERVER_VERSION}/nats-server-v${NATS_SERVER_VERSION}-darwin-arm64.tar.gz`,
        "x86_64-apple-darwin": `https://github.com/nats-io/nats-server/releases/download/v${NATS_SERVER_VERSION}/nats-server-v${NATS_SERVER_VERSION}-darwin-amd64.tar.gz`,
        "x86_64-pc-windows-msvc": `https://github.com/nats-io/nats-server/releases/download/v${NATS_SERVER_VERSION}/nats-server-v${NATS_SERVER_VERSION}-windows-amd64.zip`,
      };
      const url = map[t];
      if (!url) throw new Error(`nats-server: unsupported target ${t}`);
      return url;
    },
    innerPath: (t) => {
      if (t === "aarch64-apple-darwin")
        return `nats-server-v${NATS_SERVER_VERSION}-darwin-arm64/nats-server`;
      if (t === "x86_64-apple-darwin")
        return `nats-server-v${NATS_SERVER_VERSION}-darwin-amd64/nats-server`;
      if (t === "x86_64-pc-windows-msvc")
        return `nats-server-v${NATS_SERVER_VERSION}-windows-amd64/nats-server.exe`;
      throw new Error(`nats-server: unsupported target ${t}`);
    },
    outName: (t) => (t.endsWith("windows-msvc") ? "nats-server.exe" : "nats-server"),
  },
  // uv + uvx ship in one Astral release archive. We declare them as
  // two pins (same URL, different innerPath) so each lands as its own
  // entry in the staging tree. Yes the build downloads the archive
  // twice — ~22 MB — acceptable cost for matching the existing
  // single-binary-per-pin shape rather than introducing a new variant.
  // Without these the daemon's MCP server-time tool fails with
  // `spawn uvx ENOENT` on every fresh install.
  ...(["uv", "uvx"] as const).map<ExternalCliPin>((bin) => ({
    name: bin,
    version: UV_VERSION,
    url: (t) => {
      const map: Record<string, string> = {
        "aarch64-apple-darwin": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
        "x86_64-apple-darwin": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`,
        "x86_64-pc-windows-msvc": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
      };
      const url = map[t];
      if (!url) throw new Error(`${bin}: unsupported target ${t}`);
      return url;
    },
    innerPath: (t) => {
      // macOS tarball nests under `uv-<triple>/`; Windows zip is flat.
      if (t === "aarch64-apple-darwin") return `uv-aarch64-apple-darwin/${bin}`;
      if (t === "x86_64-apple-darwin") return `uv-x86_64-apple-darwin/${bin}`;
      if (t === "x86_64-pc-windows-msvc") return `${bin}.exe`;
      throw new Error(`${bin}: unsupported target ${t}`);
    },
    outName: (t) => (t.endsWith("windows-msvc") ? `${bin}.exe` : bin),
  })),
  // Friday's `web` agent invokes `agent-browser` via execFile (see
  // packages/bundled-agents/src/web/tools/browse.ts:67). Bundling the
  // native binary directly from upstream's GitHub Releases avoids the
  // npm-install dance and keeps install-time network deps to one
  // (Chrome download via `agent-browser install`, run during the wizard's
  // "Setting up tools…" phase). Naming convention from agent-browser/
  // scripts/postinstall.js: agent-browser-<platform>-<arch>(.exe).
  {
    name: "agent-browser",
    version: AGENT_BROWSER_VERSION,
    url: (t) => {
      const map: Record<string, string> = {
        "aarch64-apple-darwin": `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-darwin-arm64`,
        "x86_64-apple-darwin": `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-darwin-x64`,
        "x86_64-pc-windows-msvc": `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-win32-x64.exe`,
      };
      const url = map[t];
      if (!url) throw new Error(`agent-browser: unsupported target ${t}`);
      return url;
    },
    // Single-file release — the URL IS the binary, no archive layer.
    innerPath: () => "",
    outName: (t) => (t.endsWith("windows-msvc") ? "agent-browser.exe" : "agent-browser"),
  },
];

// Directory bundles — assets that ship as a tree, not a single binary.
// Currently just Node.js: npm and npx are shell shims that delegate to
// `bin/node` and require the sibling `lib/node_modules/npm` tree to
// resolve their entry-point JS files. Stripping the layout breaks npm,
// so we ship the whole distribution under node-runtime/.
//
// Without this the daemon logs:
//   No FRIDAY_NPX_PATH configured, MCP servers using npx may not work
//   No FRIDAY_NODE_PATH configured, bundled claude-code agent may not work
const EXTERNAL_BUNDLES: readonly ExternalBundlePin[] = [
  {
    name: "node",
    version: NODE_VERSION,
    url: (t) => {
      const map: Record<string, string> = {
        "aarch64-apple-darwin": `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        "x86_64-apple-darwin": `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
        "x86_64-pc-windows-msvc": `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
      };
      const url = map[t];
      if (!url) throw new Error(`node: unsupported target ${t}`);
      return url;
    },
    archiveRoot: (t) => {
      if (t === "aarch64-apple-darwin") return `node-v${NODE_VERSION}-darwin-arm64`;
      if (t === "x86_64-apple-darwin") return `node-v${NODE_VERSION}-darwin-x64`;
      if (t === "x86_64-pc-windows-msvc") return `node-v${NODE_VERSION}-win-x64`;
      throw new Error(`node: unsupported target ${t}`);
    },
    outDir: "node-runtime",
    shasumsUrl: () => `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
  },
];

// Pure-Go binaries built from the repo's go.mod. Cross-compile via GOOS/GOARCH;
// CGO stays off so we don't drag in a per-target C toolchain in CI.
interface GoBinary {
  name: string;
  pkg: string;
  // cgo: opt out of the default CGO_ENABLED=0. Required for
  // friday-launcher on macOS because fyne.io/systray's darwin backend
  // talks to Cocoa via cgo. Windows builds of fyne.io/systray are
  // pure Win32 and work either way.
  cgo?: boolean;
}

const GO_BINARIES: readonly GoBinary[] = [
  // friday-launcher is the post-install supervisor + tray app. Lives in
  // the root Go module like every other tools/* binary. cgo:true because
  // fyne.io/systray needs Cocoa on macOS (Windows backend is pure Win32 —
  // cgo build there is a no-op overhead, fine to keep on for uniformity).
  { name: "friday-launcher", pkg: "./tools/friday-launcher", cgo: true },
  // webhook-tunnel: chi HTTP server + cloudflared subprocess manager.
  // Replaces the 997 MB Deno-compiled binary with a ~10 MB pure-Go one.
  { name: "webhook-tunnel", pkg: "./tools/webhook-tunnel" },
];

function goEnvForTarget(target: string): { GOOS: string; GOARCH: string } {
  switch (target) {
    case "aarch64-apple-darwin":
      return { GOOS: "darwin", GOARCH: "arm64" };
    case "x86_64-apple-darwin":
      return { GOOS: "darwin", GOARCH: "amd64" };
    case "x86_64-pc-windows-msvc":
      return { GOOS: "windows", GOARCH: "amd64" };
    default:
      throw new Error(`Go: unsupported target ${target}`);
  }
}

const DENO_BINARIES = [
  {
    // Ships as `friday` — the user-visible CLI name. The internal codebase
    // still uses "atlas" everywhere; only the compiled binary is renamed.
    // Includes are .yml templates read at runtime via
    // readFileSync(fileURLToPath(new URL("./X.yml", import.meta.url))) —
    // a pattern deno compile does NOT auto-detect (it's a runtime
    // string interpolation, not a static module import). Every such
    // file in friday's import graph must be listed here explicitly.
    name: "friday",
    entry: "apps/atlas-cli/src/otel-bootstrap.ts",
    flags: ["--unstable-worker-options", "--unstable-kv", "--unstable-raw-imports"],
    // Liberal include of every packages/ subtree that has runtime
    // resources (yml templates, SKILL.md walks, worker.ts files
    // dispatched to new Worker(import.meta.url, ...)). deno compile
    // doesn't auto-detect any of these — they're runtime string
    // resolution, not static imports. Whitelisting individual files
    // turned into whack-a-mole; ~510KB of resource files across
    // these dirs is 0.05% of the 990MB binary so being liberal is
    // the right trade.
    include: [
      "packages/system", // system.yml + skills/ walker
      "packages/workspace", // user-workspace-template.yml
      "packages/fsm-engine", // function-executor.worker.ts via Worker(new URL(...))
      // The web agent's prompt builder reads .md files at runtime via
      // readFileSync(new URL("./skill/<f>.md", import.meta.url)) — see
      // packages/bundled-agents/src/web/prompts.ts. deno-compile doesn't
      // auto-detect this (runtime URL resolution, not a static import),
      // so the skill dir has to be on the include allowlist explicitly.
      "packages/bundled-agents/src/web/skill",
    ] as string[],
  },
  {
    name: "link",
    entry: "apps/link/src/index.ts",
    flags: ["--unstable-worker-options", "--unstable-kv", "--unstable-raw-imports"],
    include: [] as string[],
  },
  {
    name: "playground",
    entry: "tools/agent-playground/static-server.ts",
    flags: ["--unstable-worker-options", "--unstable-kv", "--unstable-raw-imports"],
    include: ["tools/agent-playground/build"],
  },
];

function exeExt(target: string): string {
  return target.endsWith("windows-msvc") ? ".exe" : "";
}

function archiveExt(target: string): "tar.zst" | "zip" {
  // zstd over tar gives ~10–15% better ratio than gzip at equivalent
  // wall-clock with -T0 parallelism. Windows still ships .zip because
  // Tauri-installer's webview2 + the underlying NSIS bundle expect zip
  // on Windows, and there's no parallel zstd on Win runners by default.
  return target.endsWith("windows-msvc") ? "zip" : "tar.zst";
}

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
  console.log(`+ ${cmd.join(" ")}`);
  const [bin, ...args] = cmd;
  if (!bin) throw new Error("run() requires a non-empty command array");
  const proc = new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: { ...Deno.env.toObject(), ...(opts.env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await proc.output();
  if (code !== 0) throw new Error(`Command failed (exit ${code}): ${cmd.join(" ")}`);
}

async function ensureDir(p: string): Promise<void> {
  await Deno.mkdir(p, { recursive: true });
}

async function rmRf(p: string): Promise<void> {
  try {
    await Deno.remove(p, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

// Exclude tests, fixtures, and dev-only sub-trees from the embedded source.
// `deno compile` ships the entire reachable file graph as raw TS, including
// every sibling file in the same directory; excluding tests alone cuts the
// per-binary footprint by hundreds of MB without touching runtime behavior.
const COMPILE_EXCLUDES = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/__tests__/**",
  "**/__fixtures__/**",
  "**/fixtures/**",
  "**/test-utils/**",
  "**/*.bench.ts",
];

async function compileDeno(
  target: string,
  bin: (typeof DENO_BINARIES)[number],
  outPath: string,
  repoRoot: string,
): Promise<void> {
  // --config deno.compile.json overrides nodeModulesDir to "none". The
  // root deno.json keeps "auto" so the rest of the build pipeline
  // (npm install, svelte-kit sync, vite build) has a real node_modules/
  // to read. But `deno compile` invoked with the compile-only config
  // skips embedding node_modules into the binary — that alone saves
  // ~70 MB per binary out of an otherwise duplicated 1.1 GB.
  const args = [
    "compile",
    "-A",
    "--no-check",
    "--config=deno.compile.json",
    `--target=${target}`,
    ...bin.flags,
    ...bin.include.map((i) => `--include=${i}`),
    ...COMPILE_EXCLUDES.map((e) => `--exclude=${e}`),
    "--output",
    outPath,
    bin.entry,
  ];
  await run(["deno", ...args], { cwd: repoRoot, env: { RUST_MIN_STACK: "33554432" } });
}

async function compileGo(
  target: string,
  bin: GoBinary,
  outPath: string,
  repoRoot: string,
): Promise<void> {
  const env = goEnvForTarget(target);
  // CGO is enabled per-target only when (a) the binary opts in via
  // bin.cgo AND (b) the target needs a C runtime. fyne.io/systray's
  // darwin backend talks to Cocoa via cgo (CGO required); its
  // Windows backend is pure-Win32 (CGO would force a mingw cross-
  // toolchain in CI for no benefit). Linux is similar to darwin
  // (gtk/dbus via cgo) — handled here for forward-compat even though
  // we don't ship Linux today.
  // -trimpath + ldflags strip debug/path info to shrink the binary slightly.
  const targetNeedsCgo = env.GOOS === "darwin" || env.GOOS === "linux";
  const cgo = bin.cgo && targetNeedsCgo ? "1" : "0";
  await run(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", outPath, bin.pkg], {
    cwd: repoRoot,
    env: { ...env, CGO_ENABLED: cgo },
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`+ download ${url}`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Download failed: ${url} → ${resp.status}`);
  const ab = await resp.arrayBuffer();
  await Deno.writeFile(dest, new Uint8Array(ab));
}

async function extractArchive(archivePath: string, outDir: string): Promise<void> {
  await ensureDir(outDir);
  if (archivePath.endsWith(".zip")) {
    await run(["unzip", "-q", "-o", archivePath, "-d", outDir]);
  } else if (archivePath.endsWith(".tgz") || archivePath.endsWith(".tar.gz")) {
    await run(["tar", "-xzf", archivePath, "-C", outDir]);
  } else if (archivePath.endsWith(".tar.zst") || archivePath.endsWith(".tzst")) {
    await run(["tar", "--use-compress-program=zstd -d", "-xf", archivePath, "-C", outDir]);
  } else {
    throw new Error(`Unknown archive type: ${archivePath}`);
  }
}

/** Fetches a SHASUMS256-style file and returns the hex digest matching
 * the given asset filename. Throws if the asset isn't listed. */
async function fetchShasum(shasumsUrl: string, assetName: string): Promise<string> {
  const resp = await fetch(shasumsUrl, { redirect: "follow" });
  if (!resp.ok) throw new Error(`SHASUMS fetch ${shasumsUrl} → HTTP ${resp.status}`);
  const body = await resp.text();
  for (const line of body.split("\n")) {
    const [hex, name] = line.trim().split(/\s+/);
    if (name === assetName || name === `*${assetName}`) {
      if (!hex || hex.length !== 64)
        throw new Error(`SHASUMS: bad digest for ${assetName}: ${hex}`);
      return hex.toLowerCase();
    }
  }
  throw new Error(`SHASUMS: ${assetName} not listed in ${shasumsUrl}`);
}

async function bundleExternalBundle(
  target: string,
  bundle: ExternalBundlePin,
  outDir: string,
  scratch: string,
): Promise<void> {
  const url = bundle.url(target);
  const fileName = url.split("/").pop();
  if (!fileName) throw new Error(`${bundle.name}: cannot derive filename from URL: ${url}`);
  const downloadPath = join(scratch, fileName);
  await downloadFile(url, downloadPath);

  const want = await fetchShasum(bundle.shasumsUrl(target), fileName);
  const got = await sha256OfFile(downloadPath);
  if (got !== want) {
    throw new Error(`${bundle.name}: sha256 mismatch for ${fileName}: got=${got} want=${want}`);
  }

  const extractDir = join(scratch, `${bundle.name}-extract`);
  await rmRf(extractDir);
  await extractArchive(downloadPath, extractDir);

  // Strip the archive's top-level dir by moving its contents up.
  const innerRoot = join(extractDir, bundle.archiveRoot(target));
  const dest = join(outDir, bundle.outDir);
  await rmRf(dest);
  await ensureDir(outDir);
  await Deno.rename(innerRoot, dest);
}

async function bundleExternalCli(
  target: string,
  cli: ExternalCliPin,
  outDir: string,
  scratch: string,
): Promise<void> {
  await ensureDir(outDir);
  const url = cli.url(target);
  const fileName = url.split("/").pop();
  if (!fileName) throw new Error(`${cli.name}: cannot derive filename from URL: ${url}`);
  const downloadPath = join(scratch, fileName);
  await downloadFile(url, downloadPath);

  const isArchive =
    fileName.endsWith(".zip") || fileName.endsWith(".tgz") || fileName.endsWith(".tar.gz");
  const innerRel = cli.innerPath(target);
  const dest = join(outDir, cli.outName(target));

  if (!isArchive) {
    // direct binary download (e.g. cloudflared on Windows)
    await Deno.copyFile(downloadPath, dest);
  } else {
    const extractDir = join(scratch, `${cli.name}-extract`);
    await rmRf(extractDir);
    await extractArchive(downloadPath, extractDir);
    const inner = innerRel ? join(extractDir, innerRel) : extractDir;
    await Deno.copyFile(inner, dest);
  }
  await Deno.chmod(dest, 0o755).catch(() => {}); // no-op on Windows
}

/** Whether the build host can execute a binary built for `target`. Cross-
 * arch builds (e.g. building x86_64 macOS artifacts on aarch64-apple-darwin
 * via Rosetta is intentionally NOT trusted here — Rosetta presence is
 * configurable and CI doesn't enable it) skip exec-dependent smoke tests. */
function canExecTarget(target: string): boolean {
  const hostOs = Deno.build.os; // "darwin" | "linux" | "windows"
  const hostArch = Deno.build.arch; // "x86_64" | "aarch64"
  if (target === "aarch64-apple-darwin") return hostOs === "darwin" && hostArch === "aarch64";
  if (target === "x86_64-apple-darwin") return hostOs === "darwin" && hostArch === "x86_64";
  if (target === "x86_64-pc-windows-msvc") return hostOs === "windows" && hostArch === "x86_64";
  return false;
}

/** Run agent-browser --version against the freshly-bundled binary. Catches
 * HTML 404 capture / wrong-arch slip / missing-exec-bit / corrupt-download
 * cases that the HTTPS-only download path can't detect. Build fails loudly
 * on any non-zero exit so a bad release never reaches users. */
async function smokeTestAgentBrowser(target: string, stagingDir: string): Promise<void> {
  const binName = target.endsWith("windows-msvc") ? "agent-browser.exe" : "agent-browser";
  // Stack 3: agent-browser lives under <staging>/bin/ alongside the
  // other supervised binaries.
  const binPath = join(stagingDir, "bin", binName);
  console.log(`[build-studio] smoke test: ${binPath} --version`);
  const result = await new Deno.Command(binPath, {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const out = new TextDecoder().decode(result.stdout);
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(
      `agent-browser smoke test failed (exit ${result.code}):\n` +
        `  stdout: ${out.trim() || "<empty>"}\n` +
        `  stderr: ${err.trim() || "<empty>"}`,
    );
  }
  const version = new TextDecoder().decode(result.stdout).trim();
  console.log(`[build-studio] smoke test ok: ${version}`);
}

async function archiveStaging(
  target: string,
  stagingDir: string,
  outArchive: string,
): Promise<void> {
  if (archiveExt(target) === "zip") {
    // PowerShell on Windows; on macOS we don't reach this branch.
    const isWindows = Deno.build.os === "windows";
    if (isWindows) {
      await run([
        "powershell",
        "-Command",
        `Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${outArchive}' -Force`,
      ]);
    } else {
      // Useful when building Windows artifacts from macOS for local QA.
      await run(["zip", "-r", "-q", outArchive, "."], { cwd: stagingDir });
    }
  } else {
    // tar piped through parallel zstd. -T0 = use all cores. -19 is the
    // high-ratio setting (close to the maximum without the --long flag's
    // memory blow-up); empirical: ~10–15% smaller than gzip + faster
    // due to parallelism. macOS 12.4+ and Linux runners both ship
    // /usr/bin/zstd; CI ubuntu-latest has it.
    await run([
      "tar",
      "--use-compress-program=zstd -T0 -19",
      "-cf",
      outArchive,
      "-C",
      stagingDir,
      ".",
    ]);
  }
}

async function sha256OfFile(p: string): Promise<string> {
  const data = await Deno.readFile(p);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function manifestPlatformKey(target: string): string {
  switch (target) {
    case "aarch64-apple-darwin":
      return "macos-arm";
    case "x86_64-apple-darwin":
      return "macos-intel";
    case "x86_64-pc-windows-msvc":
      return "windows";
    default:
      throw new Error(`No manifest key for target: ${target}`);
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["target", "version", "out"],
    boolean: ["skip-compile", "skip-external"],
    default: { out: "dist", "skip-compile": false, "skip-external": false },
  }) as unknown as {
    target?: string;
    version?: string;
    out: string;
    "skip-compile": boolean;
    "skip-external": boolean;
  };

  if (!flags.target) throw new Error("--target required (e.g. aarch64-apple-darwin)");
  if (!flags.version) throw new Error("--version required (e.g. 0.0.1)");

  const opts: CliFlags = {
    target: flags.target,
    version: flags.version,
    outDir: flags.out,
    skipCompile: flags["skip-compile"],
    skipExternal: flags["skip-external"],
  };

  // Worktree-aware repo root: this script lives in <repo>/scripts/.
  // `URL.pathname` returns `/D:/a/.../scripts/` on Windows — invalid as a
  // filesystem path. fileURLToPath() handles the OS-specific conversion.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");

  console.log(`[build-studio] target=${opts.target} version=${opts.version}`);

  const targetOut = join(repoRoot, opts.outDir, opts.target);
  const stagingDir = join(targetOut, "staging");
  const scratchDir = join(targetOut, "scratch");
  await rmRf(stagingDir);
  await rmRf(scratchDir);
  await ensureDir(stagingDir);
  await ensureDir(scratchDir);

  // Make sure the playground build artifact exists before deno-compile embeds it.
  const playgroundBuild = join(repoRoot, "tools/agent-playground/build");
  if (!existsSync(playgroundBuild)) {
    console.log("[build-studio] playground build missing — running vite build…");
    await run(["npm", "run", "build"], { cwd: join(repoRoot, "tools/agent-playground") });
  }

  // Stack 3 split-destination layout:
  //   <staging>/friday-launcher              ← top-level: macOS .app
  //                                              wrapper launches this
  //                                              path, must stay where
  //                                              the wrapper expects it.
  //   <staging>/bin/friday                   ← every supervised binary
  //   <staging>/bin/link                       lives under bin/ so it
  //   <staging>/bin/webhook-tunnel             can't collide with a
  //   <staging>/bin/playground                 user-data dir name (e.g.
  //   <staging>/bin/nats-server                link-data/wiring.db) and
  //   <staging>/bin/agent-browser              the launcher's friday-home
  //   <staging>/bin/cloudflared                stays clean of binaries.
  //   <staging>/bin/gh
  //   <staging>/bin/uv
  //   <staging>/bin/uvx
  //   <staging>/bin/node-runtime/...
  //
  // friday-launcher's auto-detect (tools/friday-launcher/main.go:260-296)
  // already prefers ~/.friday/local/bin/ over the flat layout, so this
  // change is the only piece needed on the package side — the launcher
  // picks it up automatically.
  const binStaging = join(stagingDir, "bin");
  await ensureDir(binStaging);

  if (!opts.skipCompile) {
    for (const bin of DENO_BINARIES) {
      const outPath = join(binStaging, `${bin.name}${exeExt(opts.target)}`);
      await compileDeno(opts.target, bin, outPath, repoRoot);
    }
    for (const bin of GO_BINARIES) {
      // friday-launcher is the .app's entry point — it needs to live
      // at the top of the install dir so the macOS Info.plist's
      // ProgramArguments path resolves. Every other Go binary is
      // launcher-supervised and goes under bin/.
      const dest = bin.name === "friday-launcher" ? stagingDir : binStaging;
      const outPath = join(dest, `${bin.name}${exeExt(opts.target)}`);
      await compileGo(opts.target, bin, outPath, repoRoot);
    }
  } else {
    console.log("[build-studio] --skip-compile set, skipping deno + go compile");
  }

  // Sidecar read at playground startup via dirname(Deno.execPath()) to
  // distinguish release builds from `deno task playground` (no sidecar → dev).
  await Deno.writeTextFile(join(binStaging, ".studio-version"), `${opts.version}\n`);

  if (!opts.skipExternal) {
    for (const cli of EXTERNAL_CLIS) {
      await bundleExternalCli(opts.target, cli, binStaging, scratchDir);
    }
    for (const bundle of EXTERNAL_BUNDLES) {
      await bundleExternalBundle(opts.target, bundle, binStaging, scratchDir);
    }

    // Smoke test bundled agent-browser. The other EXTERNAL_CLIS get
    // exercised at runtime by services that probe them on startup
    // (gh, cloudflared, nats-server, uv/uvx via FRIDAY_*_PATH); a bad
    // download surfaces immediately on first launch. agent-browser
    // is only invoked by the `web` agent at user-action time, so a
    // bad download wouldn't surface until a user runs a browse query.
    // Build-time --version probes catch HTML 404 / wrong-arch /
    // missing-exec-bit failures before publish.
    //
    // Only run when the build host can exec the target binary. Cross-
    // arch builds skip the test silently — CI runs each target on
    // its native host so the smoke test still runs in practice.
    if (canExecTarget(opts.target)) {
      await smokeTestAgentBrowser(opts.target, stagingDir);
    } else {
      console.log(
        `[build-studio] skipping agent-browser smoke test (host ${Deno.build.arch}-${Deno.build.os} cannot exec target ${opts.target})`,
      );
    }
  } else {
    console.log("[build-studio] --skip-external set, skipping CLI bundling");
  }

  const archiveName = `friday-studio_${opts.version}_${opts.target}.${archiveExt(opts.target)}`;
  const archivePath = join(repoRoot, opts.outDir, archiveName);
  await rmRf(archivePath);

  await archiveStaging(opts.target, stagingDir, archivePath);
  const sha = await sha256OfFile(archivePath);
  const stat = await Deno.stat(archivePath);

  const sidecar = `${archivePath}.sha256`;
  await Deno.writeTextFile(sidecar, `${sha}  ${archiveName}\n`);

  const platformKey = manifestPlatformKey(opts.target);
  const entry = {
    [platformKey]: {
      url: `https://download.fridayplatform.io/studio/${archiveName}`,
      sha256: sha,
      size: stat.size,
    },
  };

  const entryPath = join(
    repoRoot,
    opts.outDir,
    `friday-studio_${opts.version}_${opts.target}.json`,
  );
  await Deno.writeTextFile(entryPath, JSON.stringify(entry, null, 2));

  console.log("");
  console.log(
    `[build-studio] ✓ artifact:   ${archivePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`,
  );
  console.log(`[build-studio] ✓ sha256:     ${sha}`);
  console.log(`[build-studio] ✓ entry:      ${entryPath}`);
  console.log(`[build-studio] ✓ key:        ${platformKey}`);

  // Clean scratch + staging — keep only the archive + sidecar + entry.
  await rmRf(scratchDir);
}

if (import.meta.main) {
  await main();
}
