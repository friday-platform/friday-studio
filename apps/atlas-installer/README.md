# Atlas Installer (Tauri)

Cross-platform installer for Atlas CLI built with Tauri and Deno.

## Architecture

- **Frontend**: Vanilla HTML/CSS/TypeScript (no framework)
- **Backend**: Rust with Tauri 2.x
- **Build System**: Deno for TypeScript compilation, npm for Tauri CLI

## Structure

```
apps/atlas-installer/
├── src/                    # TypeScript source
│   ├── renderer-tauri.ts   # Tauri IPC adapter
│   └── renderer.ts         # Main installer logic
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── lib.rs         # All IPC handlers (650+ lines)
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index-tauri.html        # Installer UI
├── atlas-binary/           # Atlas binaries to bundle
├── package.json            # Deno-based build scripts
└── tsconfig.json
```

## Build Commands

All commands use Deno (no npm required except for initial dependency install):

```bash
# Development (auto-compiles + runs static file server + Tauri)
deno task tauri:dev

# Manual compile + serve (if needed separately)
deno task compile    # TypeScript → JavaScript
deno task serve      # Static file server on :1420

# Production builds
deno task tauri:build         # Current platform
deno task tauri:build:mac     # macOS ARM64
deno task tauri:build:mac:x64 # macOS Intel
deno task tauri:build:win     # Windows x64
```

### Dev Workflow

When you run `deno task tauri:dev`:
1. Compiles TypeScript to JavaScript
2. Starts Deno static file server on port 1420
3. Launches Tauri app connecting to http://localhost:1420/index-tauri.html

## Key Features

### Rust IPC Handlers (src-tauri/src/lib.rs)

1. **Platform detection**: `get_platform()`
2. **Directory management**: `create_atlas_dir()`
3. **Environment configuration**: `.env` read/write operations
4. **Binary installation**:
   - Stop existing daemon
   - Copy atlas binary
   - Set executable permissions
   - Create symlinks (macOS)
   - Install web client
5. **PATH setup**:
   - Shell profiles (macOS)
   - Windows registry
6. **Service management**: launchctl/schtasks integration
7. **EULA loading**

### Privilege Escalation

- **macOS**: Uses `osascript` with "administrator privileges"
- **Windows**: PowerShell for PATH, expects UAC elevation for service operations

### Resource Bundling

- Atlas binaries in `atlas-binary/`
- Bundled as Tauri resources
- Available at runtime via `app.path().resource_dir()`

## Size Comparison

- **Electron installer**: 263MB
- **Tauri installer**: ~15-30MB (estimated 88-94% reduction)

## Migration from Electron

The Tauri version maintains API compatibility via `renderer-tauri.ts` adapter:
- Wraps Tauri's `invoke()` to match Electron IPC interface
- Existing `renderer.ts` (750 lines) works unchanged
- No frontend logic rewrite needed

## Development

Prerequisites:
- **Deno** (primary build tool - TypeScript compilation)
- **Rust** (Tauri backend)
- **pnpm** (only for installing Tauri CLI dependency)

### Deno-First Architecture

Unlike traditional npm projects, this installer uses **Deno as the primary build tool**:

- **No node_modules bloat**: TypeScript compiled via `deno run npm:typescript/tsc`
- **Native Deno tasks**: Use `deno task <name>` instead of `npm run <name>`
- **Minimal package.json**: Only for Tauri npm dependencies (`@tauri-apps/api`, `@tauri-apps/cli`)

### Initial Setup

```bash
# Install Tauri CLI (one-time via workspace root)
cd ../../ && pnpm install

# Compile TypeScript
deno task compile

# Verify Rust compilation
cd src-tauri && cargo check
```

## TODO

- [ ] Add atlas binaries to `atlas-binary/` directory
- [ ] Test installation flow end-to-end
- [ ] Update GitHub Actions workflow for Tauri builds
- [ ] Measure actual installer size vs Electron
