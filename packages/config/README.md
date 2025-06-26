# @atlas/config

Configuration management package for Atlas.

## Overview

This package provides configuration schemas, defaults, and validation for Atlas workspaces.

## Installation

This package is part of the Atlas monorepo and is available internally via:

```typescript
import { loadConfig, validateConfig } from "@atlas/config";
```

## Features

- Configuration schemas for workspaces, supervisors, and agents
- Default configuration templates
- Configuration validation utilities
- Workspace initialization helpers

## Dependencies

- `@atlas/types` - Shared type definitions
- `@atlas/storage` - For configuration persistence

## Migration Status

🚧 This package is being migrated from the following locations:

- `src/config/` - Configuration files and defaults
- `src/core/workspace-config.ts` - Workspace configuration logic
- `src/core/config-loader.ts` - Configuration loading utilities
