# Signals UI Implementation Plan

## Overview

This document outlines the comprehensive implementation plan for enhancing the Atlas interactive UI signals feature. The goal is to transform the current basic signals display into a rich, interactive documentation and testing interface that helps users understand, configure, and test workspace signals effectively.

## Current State Analysis

### Existing SignalsTab Architecture
- **Two-column layout**: 25% sidebar, 75% main area
- **Basic functionality**: Signal list navigation, provider/description display
- **Schema support**: Zod validation for JSON schemas, recursive property documentation
- **Keyboard navigation**: j/k or arrow keys for signal selection
- **Foundation**: Solid React/Ink implementation with proper state management

### Signal Ecosystem Analysis
Based on analysis of workspace configurations across Atlas examples, signals fall into distinct categories:

**Provider Types:**
- **HTTP** (webhooks, REST endpoints) - 45% of signals
- **CLI** (command-line interfaces) - 25% of signals  
- **Specialized** (codebase-watcher, k8s-events, cron) - 20% of signals
- **Webhooks** (GitHub, Linear, monitoring services) - 10% of signals

**Complexity Levels:**
- **Simple**: Basic provider + description (40%)
- **Intermediate**: With JSON schema validation (35%) 
- **Advanced**: Complex schemas, security, retries (20%)
- **Expert**: Multi-provider integration, conditional logic (5%)

## Implementation Plan

### Phase 1: Enhanced Signal Documentation Display
**Timeline: Sprint 1 (2 weeks)**

#### 1.1 Provider-Specific Information Display
Extend the main area to show provider-specific details based on signal type:

**HTTP Signals:**
- Method and path display with syntax highlighting
- Headers configuration (if present)
- Webhook security settings (secrets, signature validation)
- Timeout and retry configuration

**CLI Signals:**
- Command syntax and available flags
- Interactive command builder
- Parameter validation and examples

**Specialized Providers:**
- **Codebase Watcher**: File patterns, ignore lists, debounce settings
- **K8s Events**: Namespace configuration, retry policies
- **Cron Scheduler**: Schedule expression breakdown, timezone info

#### 1.2 Enhanced Schema Documentation
Improve the existing schema display with:

**Visual Enhancements:**
- Type badges with color coding (string=blue, number=green, boolean=orange)
- Show enum values with clear formatting
- Required field highlighting with clear visual indicators

**Interactive Features:**
- Schema example generator (creates sample JSON payload)

### Phase 2: Provider-Specific Usage Examples
**Timeline: Sprint 2 (2 weeks)**

#### 2.1 HTTP Signal Examples
Generate contextual usage examples based on signal configuration:

**Curl Command Generation:**
```bash
# Generated for HTTP signals
curl -X POST http://localhost:8080/test-mcp \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "read",
    "path": "/tmp/example.txt"
  }'
```

**Features:**
- Auto-generate from schema (if present) or provide template
- Include authentication headers (if configured)
- Show both minimal and full payload examples

#### 2.2 CLI Signal Examples  
Show command-line usage patterns:

**Atlas CLI Commands:**
```bash
# Generated for CLI signals
atlas signal trigger test-mcp \
  --operation read \
  --path "/tmp/example.txt"

# Alternative JSON format
atlas signal trigger test-mcp \
  --data '{"operation": "read", "path": "/tmp/example.txt"}'
```


### Phase 3: Interactive Testing and Validation
**Timeline: Sprint 3 (2 weeks)**

#### 3.1 Live Signal Testing Interface
Add testing capabilities directly in the UI using existing HTTP endpoints:

**Test Panel Components:**
- **Payload Builder**: Form-based or JSON editor for signal data
- **Send Test**: Use existing `POST /signals/:signalId` endpoint 
- **Response Display**: Show processing results and agent responses
- **History**: Recent test attempts with results

**Implementation Notes:**
- Leverage existing workspace server endpoints at `POST /signals/:signalId`
- HTTP signals with custom paths are already registered dynamically (lines 196-253)
- No additional test endpoints needed - use the live signal processing system


### Phase 4: Advanced Features and Polish
**Timeline: Sprint 4 (2 weeks)**

#### 4.1 Advanced Signal Documentation
**Signal Relationships:**
- Show job connections (which jobs are triggered by this signal)
- Agent mapping visualization (which agents handle this signal type)

**Documentation Generation:**
- Export signal documentation as Markdown
- Create integration guides per signal:
  * HTTP signals: How to configure endpoints, headers, authentication
  * CLI signals: Command syntax and parameter usage
  * Codebase watcher: File pattern setup and monitoring configuration
  * K8s events: Cluster connection and namespace configuration
  * Cron scheduler: Schedule expression examples and timezone setup

#### 4.2 Enhanced Navigation and Search
**Improved Discovery:**
- Search signals by provider, schema properties, or description
- Filter by complexity level or configuration status
- Recently tested signals history

## Technical Implementation Details

### Component Architecture Enhancement

#### Enhanced SignalsTab Structure
```typescript
interface EnhancedSignalsTabProps {
  config: WorkspaceConfig;
  workspaceSlug: string; // For API calls
}

// New sub-components to implement:
- SignalDetailsSection    // Provider info, path, method details
- SchemaDocumentationSection // Enhanced schema display  
- UsageExamplesSection   // Generated curl/CLI examples
- TestingInterfaceSection // Interactive testing panel
```

#### New Utility Functions
```typescript
// Provider-specific example generation
generateCurlExample(signal: SignalConfig): string
generateCLIExample(signal: SignalConfig): string

// Schema utilities
generateSchemaExample(schema: JSONSchema): unknown
validatePayloadAgainstSchema(payload: unknown, schema: JSONSchema): ValidationResult
getSchemaComplexityScore(schema: JSONSchema): number

// Signal testing
sendTestSignal(signalId: string, payload: unknown): Promise<TestResult>
```

### API Integration Requirements

#### Existing Endpoints to Use
```typescript
// Already available in workspace-server.ts
POST /signals/:signalId         // Signal triggering (line 67)
GET  /signals                   // List signals (line 56)
GET  /sessions/:sessionId       // Session status (line 115)
GET  /sessions                  // List sessions (line 146)
```

### State Management Enhancement

#### Enhanced Local State
```typescript
interface SignalsTabState {
  selectedSignal: string | null;
  selectedIndex: number;
  viewMode: 'documentation' | 'testing';
  testPayload: unknown;
  testResults: TestResult[];
  searchFilter: string;
}
```

## UI/UX Design Principles

### Information Hierarchy
1. **Primary**: Signal name, provider, description
2. **Secondary**: Configuration details, schema overview  
3. **Tertiary**: Usage examples, testing interface
4. **Utility**: Metrics, processing info, advanced details

### Progressive Disclosure
- Start with essential information
- Expand to show detailed configuration
- Advanced features available but not overwhelming
- Context-sensitive help and examples

### Responsive Layout Strategy
```
┌─ Sidebar (25%) ─┬─ Main Area (75%) ────────────────────────┐
│ Search: [____]  │ ┌─ Signal Details ──────────────────────┐ │
│                 │ │ Provider: HTTP                     │ │
│ Filters:        │ │ Path: /test-mcp                    │ │
│ □ Has Schema    │ │                                   │ │
│ □ Tested        │ ┌─ Schema Documentation ─────────────┐ │
│ □ Complex       │ │ operation (string) *              │ │
│                 │ │ path (string) *                   │ │
│ Signal List:    │ │ content (string)                  │ │
│ ▶ test-mcp      │ │ options (object)                  │ │
│   webhook-hdlr  │ │   recursive (boolean)             │ │
│   cli-k8s       │ │   encoding (string)               │ │
│   cron-weekly   │ ┌─ Usage Examples ───────────────────┐ │
│                 │ │ curl -X POST localhost:8080/...   │ │
│                 │ │ atlas signal trigger test-mcp ... │ │
│                 │ ┌─ Test Interface ───────────────────┐ │
│                 │ │ [JSON Payload Editor]             │ │
│                 │ │ [Send Test] [Clear] [History]     │ │
└─────────────────┴─└───────────────────────────────────────┘ │
```

## Success Metrics

### User Experience Goals
- **Discovery Time**: Reduce time to understand signal usage by 70%
- **Setup Efficiency**: Decrease signal configuration errors by 60%
- **Testing Adoption**: Increase signal testing usage by 300%
- **Documentation Quality**: Achieve 95% user satisfaction with signal docs

### Technical Performance Targets
- **Load Time**: Sub-200ms signal list rendering
- **Test Response**: Signal testing results in <2 seconds
- **Schema Parsing**: Handle complex schemas (50+ properties) smoothly
- **Memory Usage**: Maintain efficient state management for 100+ signals

## Implementation Phases Summary

### Sprint 1: Enhanced Documentation Display
- **Focus**: Rich provider-specific information display
- **Deliverables**: Enhanced main area with provider details, improved schema visualization
- **Risk**: Complexity of handling different provider types

### Sprint 2: Usage Examples Generation  
- **Focus**: Contextual examples for all signal types
- **Deliverables**: Curl generation, CLI examples, webhook setup guides
- **Risk**: Maintaining accuracy of generated examples

### Sprint 3: Interactive Testing
- **Focus**: Live signal testing and validation
- **Deliverables**: Test interface, payload builder, response display
- **Risk**: API integration complexity and error handling

### Sprint 4: Advanced Features
- **Focus**: Polish, performance, and advanced functionality
- **Deliverables**: Search, filtering, metrics, documentation export
- **Risk**: Feature creep and performance optimization

## Dependencies and Prerequisites

### Technical Dependencies
- **Zod v4**: Already integrated for schema validation
- **Atlas API**: Workspace server endpoints for signal testing
- **Signal Processing**: Enhanced signal processing implementation
- **Workspace Config**: Current workspace.yml parsing and validation

### Team Dependencies
- **Backend**: API endpoints for testing and metrics
- **Signal Processing**: Integration with enhanced processing pipeline
- **DevOps**: Deployment considerations for testing infrastructure
- **Documentation**: User guides and integration examples

## Risk Mitigation

### Technical Risks
- **Complex Schema Handling**: Start with simple schemas, progressively enhance
- **API Integration**: Mock interfaces early, iterate with real API
- **Performance**: Profile early, optimize before feature completion
- **State Management**: Keep state local initially, optimize for complex scenarios

### Product Risks
- **Feature Overload**: Implement progressive disclosure, hide advanced features initially
- **User Confusion**: Extensive user testing, clear information hierarchy
- **Maintenance Burden**: Automated testing, clear component boundaries
- **Scope Creep**: Strict sprint boundaries, prioritize core functionality

This implementation plan transforms the Atlas signals UI from a basic information display into a comprehensive signal documentation, testing, and management interface that serves both new users learning the system and experienced users managing complex signal configurations.