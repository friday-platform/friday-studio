# @atlas/storage

Storage adapters and abstractions for Atlas.

## Overview

This package provides a unified storage abstraction layer with various adapter implementations for
different storage backends.

## Installation

This package is part of the Atlas monorepo and is available internally via:

```typescript
import { MemoryStorage, StorageAdapter } from "@atlas/storage";
```

## Features

- Unified storage interface
- Multiple adapter implementations:
  - In-memory storage
  - Local file storage
  - Deno KV storage
  - Library storage adapter
  - Registry storage adapter
- Async/await based API
- Type-safe operations

## Dependencies

- `@atlas/types` - Shared type definitions
- `@atlas/utils` - Utility functions

## Migration Status

🚧 This package is being migrated from the following locations:

- `src/storage/` - Main storage implementations
- `src/core/storage/` - Core storage utilities
