# Atlas Memory Manager

A terminal-based tool for navigating and managing Atlas workspace memory using the new MECMF
(Memory-Enhanced Context Management Framework). This tool has been updated to work with Atlas's
latest memory system.

## Features

- **MECMF Integration**: Uses the new Memory-Enhanced Context Management Framework for advanced
  memory operations
- **Vector Search**: Supports semantic vector search for episodic and semantic memories
- **Tab-based Navigation**: Switch between different memory types using Tab/Shift+Tab
- **Memory Browsing**: List and navigate through memory entries with arrow keys or vim-style j/k
- **Detailed View**: View complete memory entry details in a formatted table with progress bars,
  relative timestamps, and smart content parsing
- **Search**: Search within memory types using pattern matching and vector similarity
- **Statistics**: View memory usage statistics from workspace-specific storage
- **CRUD Operations**: Create, read, update, and delete memory entries through MECMF
- **Export/Import**: Export memory data to JSON format
- **Data Validation**: Validate memory data integrity

## Installation

No installation required. Run directly with Deno from the Atlas repository.

## Usage

### Interactive Mode (Default)

```bash
# Start with workspace selection (recommended)
./memory-manager.sh

# From Atlas root directory (requires full permissions for MECMF)
deno run --allow-all tools/memory_manager/main.ts

# Or specify a workspace path
deno run --allow-all tools/memory_manager/main.ts /path/to/workspace
./memory-manager.sh --workspace /path/to/workspace
```

### Workspace Selection

When you run `./memory-manager.sh` without specifying a workspace, the tool displays an interactive
workspace selector that lists all available Atlas workspaces on your system. You can:

- Use **↑/↓** arrow keys or **j/k** to navigate
- Press **Enter** to select a workspace
- Press **q** to quit
- Press **h** to see help

The workspace selector shows:

- Workspace name and status (running/stopped/etc.)
- Workspace path
- Description (if available)

### Command Line Options

```bash
# Show memory statistics for a workspace
./memory-manager.sh --stats --workspace /path/to/workspace
deno run --allow-all tools/memory_manager/main.ts --stats --workspace /path/to/workspace

# Export all memory to JSON from a workspace
./memory-manager.sh --export --workspace /path/to/workspace > backup.json
deno run --allow-all tools/memory_manager/main.ts --export --workspace /path/to/workspace > backup.json

# Validate memory data integrity for a workspace
./memory-manager.sh --validate --workspace /path/to/workspace
deno run --allow-all tools/memory_manager/main.ts --validate --workspace /path/to/workspace

# Show help
./memory-manager.sh --help
deno run --allow-all tools/memory_manager/main.ts --help
```

### Using Deno Tasks

From the `tools/memory_manager` directory:

```bash
deno task start       # Start interactive mode
deno task stats       # Show statistics
deno task export      # Export to JSON
deno task validate    # Validate data
deno task check       # Type check all files
```

## Interactive Controls

| Key                 | Action                                 |
| ------------------- | -------------------------------------- |
| `Tab` / `Shift+Tab` | Switch between memory types            |
| `↑`/`↓` or `j`/`k`  | Navigate up/down in memory list        |
| `Enter`             | View selected entry (formatted table)  |
| `e`                 | Edit selected entry (future feature)   |
| `n`                 | Create new entry (future feature)      |
| `d`                 | Delete selected entry (future feature) |
| `/`                 | Search in current memory type          |
| `r`                 | Reload memory from disk                |
| `s`                 | Save changes to disk                   |
| `h` or `?`          | Show/hide help                         |
| `q`                 | Quit                                   |
| `Esc`               | Return to list view from other modes   |

**Note**: Arrow keys (↑↓) are now fully supported alongside vim-style j/k navigation.

## Memory Types

### Working Memory

- Short-term, active processing memory
- Temporary data used during current session
- High turnover, automatically managed

### Episodic Memory

- Specific experiences and events
- Contextual information about what happened
- Tied to particular sessions or interactions

### Semantic Memory

- General knowledge and concepts
- Facts and information learned over time
- Persistent, cross-session knowledge

### Procedural Memory

- How-to knowledge and skills
- Process descriptions and procedures
- Reusable patterns and methodologies

## File Structure

```
tools/memory_manager/
├── main.ts                    # Main entry point
├── deno.json                  # Deno configuration
├── README.md                  # This file
├── types/
│   └── memory-types.ts        # TypeScript type definitions
├── utils/
│   ├── memory-loader.ts       # Memory file I/O operations
# Removed memory-operations.ts - now uses packages/memory directly
└── src/
    └── tui.ts                 # Terminal UI implementation
```

## Memory Storage Format

Memory is now stored using the MECMF system in workspace-specific directories under
`~/.atlas/memory/[workspace-name]/`:

- Uses CoALA memory management with structured JSON storage
- Vector embeddings for semantic and episodic memories
- Knowledge graph integration for semantic relationships
- Workspace isolation for multi-project support

Each entry contains:

```json
{
  "entry-id": {
    "id": "entry-id",
    "content": "actual memory content",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "accessCount": 5,
    "lastAccessed": "2024-01-01T12:00:00.000Z",
    "memoryType": "semantic",
    "relevanceScore": 0.8,
    "sourceScope": "workspace-id",
    "associations": ["related-entry-1", "related-entry-2"],
    "tags": ["important", "knowledge"],
    "confidence": 0.9,
    "decayRate": 0.1
  }
}
```

## Integration with Atlas

The memory manager now integrates directly with the MECMF system used by Atlas workspaces. It
provides real-time access to the same memory data that Atlas agents use.

Key integration features:

1. **Direct MECMF Access**: Uses the same CoALAMemoryManager as Atlas workspaces
2. **Vector Search**: Leverages the same embedding system for semantic search
3. **Workspace Isolation**: Respects workspace boundaries and memory scoping
4. **Real-time Sync**: Changes are immediately reflected in the Atlas system

## Limitations

Current version is a read-only implementation. Full CRUD operations (create, edit, delete) are
planned for future versions.

## Development

To add new features or modify the memory manager:

1. **Types**: Add new interfaces in `types/memory-types.ts`
2. **Storage**: Modify `utils/memory-loader.ts` for file operations
3. **Operations**: Use `packages/memory` directly for memory operations
4. **UI**: Update `src/tui.ts` for interface changes

Run type checking:

```bash
deno task check
```

## Troubleshooting

### "Permission denied" errors

The MECMF system requires extensive permissions for vector operations and embedding generation:

```bash
deno run --allow-all tools/memory_manager/main.ts
```

Specific permissions needed: `--allow-read`, `--allow-write`, `--allow-env`, `--allow-ffi`,
`--allow-net`, `--allow-sys`

### "No memory files found"

The tool will work with empty memory. Memory files are created automatically when Atlas stores
memory data.

### Terminal display issues

The tool works best in terminals that support ANSI colors and cursor control. If you experience
display issues, try a different terminal or disable colors by modifying the `colorize` method in
`src/tui.ts`.
