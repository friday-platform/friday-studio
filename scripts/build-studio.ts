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

const GH_VERSION = "2.78.0";
const CLOUDFLARED_VERSION = "2025.10.1";
const NATS_SERVER_VERSION = "2.12.7";

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
  { name: "pty-server", pkg: "./tools/pty-server" },
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
    // Include packages/system/workspaces/system.yml — read at runtime via
    // readFileSync(import.meta.url) which deno compile only embeds for
    // explicitly --included paths (not auto-detected from import graph).
    name: "friday",
    entry: "apps/atlas-cli/src/otel-bootstrap.ts",
    flags: ["--unstable-worker-options", "--unstable-kv", "--unstable-raw-imports"],
    include: ["packages/system/workspaces/system.yml"] as string[],
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
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
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

  if (!opts.skipCompile) {
    for (const bin of DENO_BINARIES) {
      const outPath = join(stagingDir, `${bin.name}${exeExt(opts.target)}`);
      await compileDeno(opts.target, bin, outPath, repoRoot);
    }
    for (const bin of GO_BINARIES) {
      const outPath = join(stagingDir, `${bin.name}${exeExt(opts.target)}`);
      await compileGo(opts.target, bin, outPath, repoRoot);
    }
  } else {
    console.log("[build-studio] --skip-compile set, skipping deno + go compile");
  }

  if (!opts.skipExternal) {
    for (const cli of EXTERNAL_CLIS) {
      await bundleExternalCli(opts.target, cli, stagingDir, scratchDir);
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
