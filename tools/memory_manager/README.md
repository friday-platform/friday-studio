# Atlas Memory Manager

A terminal-based tool for navigating and managing Atlas workspace memory across
different memory types (Working, Episodic, Semantic, Procedural).

## Features

- **Tab-based Navigation**: Switch between different memory types using
  Tab/Shift+Tab
- **Memory Browsing**: List and navigate through memory entries with arrow keys
  or vim-style j/k
- **Detailed View**: View complete memory entry details in a formatted table
  with progress bars, relative timestamps, and smart content parsing
- **Search**: Search within memory types using pattern matching
- **Statistics**: View memory usage statistics and storage information
- **CRUD Operations**: Create, read, update, and delete memory entries
  (view/read implemented)
- **Export/Import**: Export memory data to JSON format
- **Data Validation**: Validate memory data integrity

## Installation

No installation required. Run directly with Deno from the Atlas repository.

## Usage

### Interactive Mode (Default)

```bash
# From Atlas root directory
deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts

# Or specify a workspace path
deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts /path/to/workspace
```

### Command Line Options

```bash
# Show memory statistics
deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts --stats

# Export all memory to JSON
deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts --export > backup.json

# Validate memory data integrity
deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts --validate

# Show help
deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts --help
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

**Note**: Arrow keys (↑↓) are now fully supported alongside vim-style j/k
navigation.

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
│   └── memory-operations.ts   # CRUD operations on memory
└── src/
    └── tui.ts                 # Terminal UI implementation
```

## Memory File Format

Memory is stored in separate JSON files in the workspace's `.atlas/memory/`
directory:

- `working.json` - Working memory entries
- `episodic.json` - Episodic memory entries
- `semantic.json` - Semantic memory entries
- `procedural.json` - Procedural memory entries

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

The memory manager reads from the same memory files used by Atlas workspaces.
Changes made through the memory manager will be reflected in Atlas and vice
versa.

To ensure data consistency:

1. Save changes with `s` before exiting
2. Use `r` to reload if memory was modified externally
3. Run validation with `--validate` to check data integrity

## Limitations

Current version is a read-only implementation. Full CRUD operations (create,
edit, delete) are planned for future versions.

## Development

To add new features or modify the memory manager:

1. **Types**: Add new interfaces in `types/memory-types.ts`
2. **Storage**: Modify `utils/memory-loader.ts` for file operations
3. **Operations**: Extend `utils/memory-operations.ts` for new memory operations
4. **UI**: Update `src/tui.ts` for interface changes

Run type checking:

```bash
deno task check
```

## Troubleshooting

### "Permission denied" errors

Ensure you're running with proper permissions:

```bash
--allow-read --allow-write --unstable
```

### "No memory files found"

The tool will work with empty memory. Memory files are created automatically
when Atlas stores memory data.

### Terminal display issues

The tool works best in terminals that support ANSI colors and cursor control. If
you experience display issues, try a different terminal or disable colors by
modifying the `colorize` method in `src/tui.ts`.
