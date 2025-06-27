# Atlas HTTP Client Migration Plan

## Overview

This document outlines the successful migration of HTTP client functionality from the CLI into a
dedicated `@atlas/client` package. This migration centralized all daemon communication logic,
eliminated duplicate HTTP request code, and provides a clean, type-safe API for interacting with the
Atlas daemon.

## Architectural Decisions

### 1. Package Structure

- Created `@atlas/client` as a dedicated package in the monorepo
- Separated concerns: client logic, types, schemas, errors, and utilities
- Used Zod v4 for runtime validation of all API responses

### 2. API Design

- Renamed `DaemonClient` to `AtlasClient` for consistency
- Renamed `daemonUrl` to `url` throughout the API
- Added missing endpoints (session logs, signal triggering)
- Implemented both standard REST methods and streaming capabilities (SSE)

### 3. Type Safety

- Extracted all types into dedicated type definition files
- Created comprehensive Zod schemas for runtime validation
- Avoided using `any` or `as` type assertions
- Used proper error types with `AtlasApiError` class

### 4. Consumer Migration Strategy

- Updated all CLI modules to use `@atlas/client` instead of direct `fetch()` calls
- Maintained backward compatibility for error handling patterns
- Preserved existing module interfaces to minimize breaking changes

## Key Benefits Achieved

1. **Centralized API Logic**: All daemon communication in one place
2. **Type Safety**: Consistent types across all consumers with runtime validation
3. **Error Handling**: Standardized error handling and recovery
4. **Maintainability**: Single source of truth for API changes
5. **Testing**: Easier to mock and test HTTP interactions
6. **Reusability**: Can be used by future UIs or external tools

## Migration Summary

### Phase 1: Package Setup and Core Migration ✅

- Created package structure with proper separation of concerns
- Migrated and enhanced the client with missing functionality
- Implemented comprehensive type safety with Zod schemas

### Phase 2: Consumer Code Updates ✅

- Updated all module fetchers (`sessions`, `library`)
- Updated UI components (`LogViewer`, `SignalsTab`)
- Removed all direct HTTP requests

### Phase 3: Testing and Documentation ✅

- Created comprehensive test suite using `@std/expect`
- Added integration tests with mock servers
- Documented all architectural decisions

## Future Enhancements

1. **Request/Response Interceptors**: For logging and metrics collection
2. **Advanced Connection Management**: Connection pooling and retry logic with exponential backoff
3. **WebSocket Support**: For real-time updates beyond SSE
4. **Request Caching**: For frequently accessed data
5. **OpenAPI Integration**: Consider using Hono OpenAPI for the daemon and auto-generating the
   client from the OpenAPI spec

## Lessons Learned

1. **Singleton Pattern Challenges**: The `getAtlasClient` singleton pattern makes unit testing more
   difficult. Future iterations might consider dependency injection.
2. **Type Validation**: Runtime validation with Zod proved essential for catching API contract
   violations early.
3. **Streaming APIs**: SSE implementation required careful handling of connection lifecycle and
   error states.
4. **Test Isolation**: Integration tests with mock servers provided better coverage than attempting
   to mock the singleton client.
