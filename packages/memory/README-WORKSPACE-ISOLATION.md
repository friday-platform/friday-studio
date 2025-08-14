# Workspace-Isolated Memory Storage

Atlas now stores memory separately for each workspace, ensuring complete isolation and preventing
data mixing between different projects.

## New Storage Structure

### Before (Global Storage)

```
~/.atlas/memory/
├── working.json        # ❌ Mixed memories from all workspaces
├── episodic.json       
├── semantic.json       
├── procedural.json     
├── vectors/            # ❌ Shared vector index
└── knowledge-graph/    # ❌ Shared knowledge graph
```

### After (Workspace-Isolated Storage)

```
~/.atlas/memory/
├── .cache/               # ✅ Shared MECMF cache (embeddings models)
│   ├── model.onnx        # Cached embedding model
│   └── tokenizer.json    # Cached tokenizer
├── fresh-apple/          # ✅ Workspace-specific folder
│   ├── working.json      # ✅ Only memories from this workspace
│   ├── episodic.json      
│   ├── semantic.json      
│   ├── procedural.json    
│   ├── contextual.json    
│   ├── index.json         
│   ├── vectors/          # ✅ Workspace-specific vector search
│   └── knowledge-graph/  # ✅ Workspace-specific knowledge
├── crispy-banana/        # Different workspace
│   └── [same structure]
└── api-development/      # Another workspace
    └── [same structure]
```

## Key Benefits

### 1. **Complete Isolation**

- Each workspace has its own memory files
- No accidental sharing of sensitive information between projects
- Memory cleanup affects only the specific workspace

### 2. **Better Organization**

- Easy to backup/restore memory for specific workspaces
- Clear ownership of memory data
- Simplified debugging and troubleshooting

### 3. **Scalability**

- Memory growth doesn't affect other workspaces
- Can delete unused workspace memories without affecting others
- Parallel workspace operations don't interfere

### 4. **Security**

- Client data isolated from personal projects
- Sensitive memories stay within their workspace context
- Better compliance with data separation requirements

## Migration

### Automatic Migration

If you have existing global memory files, they will be automatically detected and can be migrated:

```typescript
import { migrateGlobalMemoriesToWorkspace, needsMigration } from "@atlas/utils";

// Check if migration is needed
if (await needsMigration()) {
  // Migrate to current workspace
  const result = await migrateGlobalMemoriesToWorkspace("my-workspace", {
    backup: true, // Create backups
    dryRun: false, // Actually perform migration
  });

  console.log(`Migrated ${result.migratedFiles.length} files`);
}
```

### Manual Migration Commands

```bash
# Check if migration is needed
atlas memory check-migration

# Migrate global memories to current workspace (with backup)
atlas memory migrate --backup

# Dry run to see what would be migrated
atlas memory migrate --dry-run

# List all workspace memory directories
atlas memory list-workspaces

# Show memory usage statistics
atlas memory stats
```

## Workspace Name Sanitization

Workspace names are automatically sanitized to create safe folder names:

```typescript
// Examples of workspace name sanitization
"My Project!"           → "my-project"
"Client/API Work"       → "client-api-work"  
"test_workspace_2024"   → "test-workspace-2024"
"Special-Characters@#"  → "special-characters"
```

## Implementation Details

### Path Resolution

```typescript
// Workspace-specific paths
getWorkspaceMemoryDir("my-workspace"); // ~/.atlas/memory/my-workspace/
getWorkspaceVectorDir("my-workspace"); // ~/.atlas/memory/my-workspace/vectors/
getWorkspaceKnowledgeGraphDir("my-workspace"); // ~/.atlas/memory/my-workspace/knowledge-graph/
```

### Storage Adapters

All memory storage adapters now use workspace-specific paths:

- `CoALALocalFileStorageAdapter` - Main memory files
- `VectorSearchLocalStorageAdapter` - Vector embeddings
- `KnowledgeGraphLocalStorageAdapter` - Knowledge graph

### MECMF Integration

The Memory-Enhanced Context Management Framework automatically benefits from workspace isolation:

- Token-aware prompt enhancement uses only workspace memories
- Memory classification stores to workspace-specific files
- Vector search indexes are workspace-scoped
- Debug logging shows workspace context

## Memory Management Commands

### View Memory Usage

```bash
# Show memory stats for all workspaces
atlas memory stats

# Show detailed info for specific workspace
atlas memory info my-workspace

# List all workspace directories
atlas memory list
```

### Cleanup Operations

```bash
# Remove empty workspace directories
atlas memory cleanup

# Backup workspace memory
atlas memory backup my-workspace

# Restore workspace memory from backup
atlas memory restore my-workspace backup-file.tar.gz

# Completely remove workspace memory (with confirmation)
atlas memory purge my-workspace --confirm
```

## Backwards Compatibility

### Legacy Support

- Existing global memory files are preserved until migration
- Old workspaces continue to function during transition period
- Migration utilities handle edge cases safely

### Gradual Migration

- Migration can be performed workspace by workspace
- No forced migration - happens when convenient
- Backup creation ensures data safety

## Performance Impact

### Positive Effects

- Faster memory operations (smaller datasets per workspace)
- Better caching (workspace-specific indices)
- Reduced memory conflicts in concurrent operations

### Storage Overhead

- Minimal increase in disk usage (mostly metadata)
- Vector indices are smaller and more focused
- Knowledge graphs are more relevant per workspace

## Best Practices

### 1. Regular Cleanup

```bash
# Run monthly to remove unused workspace directories
atlas memory cleanup

# Review memory usage quarterly  
atlas memory stats
```

### 2. Backup Strategy

```bash
# Backup critical workspaces before major changes
atlas memory backup production-workspace

# Archive completed project memories
atlas workspace archive old-project
```

### 3. Workspace Naming

- Use descriptive, consistent names
- Avoid special characters when possible
- Consider naming conventions for teams

### 4. Memory Hygiene

- Regularly review memory relevance
- Use workspace-specific memory scoping
- Leverage MECMF debug logging to optimize usage

This workspace isolation ensures that your Atlas memory system is organized, secure, and scalable as
you work with multiple projects and collaborators.
