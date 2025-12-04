# Atlas Configuration Architecture Design

## Overview

This document outlines the new configuration architecture for Atlas that separates concerns between
platform-managed components and user-configurable elements, while enabling natural language job
definition with structured execution.

## Architecture Principles

### Separation of Concerns

1. **Atlas-managed** (`atlas.yml`): WorkspaceSupervisor and SessionSupervisor core logic
2. **User-defined** (`workspace.yml`): Agents and signals specific to their workspace
3. **Job-specific** (`jobs/*.yml`): Execution patterns for signal-agent combinations
4. **Natural Language Interface**: Users describe jobs in natural language, system generates
   structured configurations

### Key Design Decisions

- **Jobs as execution units**: Concrete execution plans for specific signal-agent combinations
- **M:M signal-agent relationships**: One job can be triggered by multiple signals
- **Multi-agent type support**: Tempest first-party, LLM-based, and remote agents
- **Natural language job creation**: Structured entity recognition from prose descriptions

## Configuration Structure

> **Note**: See `docs/COMPREHENSIVE_ATLAS_EXAMPLE.yml` for a complete, validated example
> of all available atlas.yml options.

### 1. `atlas.yml` - Platform Configuration

Atlas-managed configuration for supervisor behavior and core platform capabilities.

```yaml
version: "1.0"
workspaceSupervisor:
  model: "claude-4-sonnet-20250514"
  capabilities:
    - job_trigger_evaluation
    - context_filtering
    - session_spawning
    - job_selection
  prompts:
    system: |
      You are a WorkspaceSupervisor responsible for analyzing signals and creating session contexts.
      Your capabilities are carefully maintained by the Atlas platform.
    job_evaluation: |
      Evaluate job triggers against incoming signals using declarative condition matching.
      Use the pluggable condition evaluation system for JSONLogic, simple expressions, and exact matches.
      Create session intent from the best matching job specification.
    context_filtering: |
      Create a filtered context for the session that includes only relevant workspace data.
      Filter based on job requirements, agent capabilities, and memory relevance.

sessionSupervisor:
  model: "claude-4-sonnet-20250514"
  capabilities:
    - execution_planning
    - agent_coordination
    - progress_evaluation
    - multi_stage_orchestration
  prompts:
    system: |
      You are a SessionSupervisor responsible for coordinating agent execution within a session.
      Create dynamic execution plans and adapt based on progress and job specifications.
    execution_planning: |
      Create an execution plan based on the job specification and session context.
      Support execution strategies: sequential, parallel, conditional, staged.
      Coordinate between different agent types (Tempest, LLM, remote).
    progress_evaluation: |
      Evaluate agent outputs and session progress. Determine if refinement is needed.
      Adapt the execution plan based on intermediate results and job requirements.
```

### 2. `workspace.yml` - User Workspace Configuration

User-defined agents, signals, and job references specific to their workspace.

```yaml
version: "1.0"
workspace:
  id: "workspace-uuid"
  name: "Development Team Workspace"
  description: "Handles PR reviews, deployments, and security monitoring"

agents:
  # Tempest 1st party agent
  playwright-agent:
    type: "tempest"
    agent: "playwright-visual-tester"
    version: "1.2.0"
    config:
      browsers: ["chromium", "firefox"]
      viewport: "1920x1080"

  # User-defined LLM agent
  frontend-reviewer:
    type: "llm"
    model: "claude-4-sonnet-20250514"
    purpose: "Reviews frontend code for best practices"
    tools: ["file-reader", "diff-analyzer", "web-accessibility-checker"]
    prompts:
      system: |
        You are a senior frontend engineer reviewing code changes.
        Focus on performance, accessibility, and maintainability.

  # Remote agent service
  security-scanner:
    type: "remote"
    endpoint: "https://security-api.company.com/scan"
    auth:
      type: "bearer"
      token_env: "SECURITY_API_TOKEN"
    timeout: 30000
    schema:
      input:
        type: "object"
        properties:
          files: { type: "array" }
          diff: { type: "string" }
      output:
        type: "object"
        properties:
          vulnerabilities: { type: "array" }
          score: { type: "number" }

signals:
  github-pr:
    provider: "github-webhook"
    description: "GitHub pull request events"
    schema:
      type: "object"
      properties:
        action: { type: "string" }
        pull_request: { type: "object" }
    jobs:
      - name: "frontend-review"
        condition: "pull_request.changed_files.some(f => f.filename.match(/\\.(tsx|css|js)$/))"
        job: "./jobs/frontend-pr-review.yml"
      - name: "security-review"
        condition: {
          "and": [
            { "==": [{ "var": "action" }, "opened"] },
            { ">": [{ "var": "pull_request.additions" }, 100] },
          ],
        }
        job: "./jobs/security-review.yml"

  deploy-failed:
    provider: "webhook"
    description: "Deployment failure notifications"
    jobs:
      - name: "investigate-failure"
        job: "./jobs/deploy-investigation.yml"
```

### 3. Job Specifications - Execution Patterns

Individual job files that define specific execution patterns for signal-agent combinations.

```yaml
# jobs/frontend-pr-review.yml
version: "1.0"
job:
  name: "frontend-pr-review"
  description: "Comprehensive frontend PR review with visual and accessibility testing"

  execution:
    strategy: "parallel-then-sequential"
    stages:
      # Stage 1: Independent analysis (parallel)
      - name: "analysis"
        strategy: "parallel"
        agents:
          - id: "playwright-agent"
            config:
              capture_mode: "diff"
              pages: ["index", "dashboard"]
            prompt: |
              Capture visual changes from this PR.
              Focus on layout shifts and component changes.

          - id: "security-scanner"
            input:
              files: "{signal.pull_request.changed_files}"
              diff: "{signal.pull_request.diff}"
            prompt: |
              Analyze the security scan results and prioritize findings.
              Focus on high-severity issues that block deployment.

      # Stage 2: Synthesis (sequential)
      - name: "review"
        strategy: "sequential"
        agents:
          - id: "frontend-reviewer"
            prompt: |
              Provide comprehensive frontend code review incorporating:
              Visual analysis: {stage.analysis.playwright-agent.output}
              Security findings: {stage.analysis.security-scanner.output}

              Focus on code quality, performance, and integration with existing systems.

  # SessionSupervisor guidance for this job type
  session_prompts:
    planning: |
      This is a frontend PR review job with two stages:
      1. Parallel analysis (visual + security)
      2. Comprehensive review incorporating all findings
    evaluation: |
      Job complete when:
      - Visual analysis captures meaningful changes or confirms no visual impact
      - Security scan identifies potential issues or confirms safety
      - Final review incorporates both analyses with actionable feedback
```

## Natural Language Job Creation

### User Experience Flow

1. **Natural Description**: User describes job in plain English
2. **Entity Recognition**: System identifies agents, signals, and execution patterns
3. **Structured Generation**: System creates job specification
4. **User Approval**: Present generated structure for confirmation/editing
5. **Deployment**: Save job file and update workspace configuration

### Example Natural Language Input

**User Input:**

> "When a GitHub PR contains frontend files, first have the playwright agent take screenshots, then
> the accessibility agent should review for issues, finally the frontend reviewer provides
> comprehensive feedback"

**System Processing:**

- **Signal**: "GitHub PR" → maps to `github-pr` signal
- **Condition**: "contains frontend files" → infers file pattern matching
- **Agents**: playwright-agent, accessibility-agent, frontend-reviewer (validated against workspace)
- **Strategy**: "first...then...finally" → sequential execution
- **Tasks**: Extracted from natural language descriptions

**Generated Structure:**

```yaml
job:
  name: "frontend-pr-review" # inferred from context
  description: "Frontend PR review with visual testing and accessibility analysis"
  trigger:
    signal: "github-pr"
    condition: "Pull request modifies frontend files (.tsx, .css, .js)"
  execution:
    strategy: "sequential"
    agents:
      - id: "playwright-agent"
        task: "Take screenshots of changes"
      - id: "accessibility-agent"
        task: "Review for accessibility issues"
      - id: "frontend-reviewer"
        task: "Provide comprehensive feedback incorporating visual and accessibility analysis"
```

### Entity Recognition Features

- **Agent Autocomplete**: Type-ahead suggestions from workspace agents
- **Signal Validation**: Verify signals exist and are properly configured
- **Visual Highlighting**: Recognized entities get distinct visual treatment
- **Condition Inference**: Natural language conditions converted to executable expressions
- **Strategy Detection**: Execution patterns inferred from temporal language ("first", "then",
  "parallel")

## Agent Type Handling

### Tempest First-Party Agents

```yaml
playwright-agent:
  type: "tempest"
  agent: "playwright-visual-tester" # Catalog reference
  version: "1.2.0"
  config:
    browsers: ["chromium", "firefox"]
    viewport: "1920x1080"
```

**Characteristics:**

- Managed by Atlas platform
- Version-controlled capabilities
- Configuration-driven behavior
- Built-in tools and integrations

### LLM-Based Agents

```yaml
frontend-reviewer:
  type: "llm"
  model: "claude-4-sonnet-20250514"
  purpose: "Reviews frontend code for best practices"
  tools: ["file-reader", "diff-analyzer"]
  prompts:
    system: |
      You are a senior frontend engineer reviewing code changes.
```

**Characteristics:**

- User-defined prompts and behavior
- Flexible tool selection
- Custom domain expertise
- Rapid prototyping and iteration

### Remote Agents

```yaml
security-scanner:
  type: "remote"
  endpoint: "https://security-api.company.com/scan"
  auth:
    type: "bearer"
    token_env: "SECURITY_API_TOKEN"
  schema:
    input: { type: "object", properties: { ... } }
    output: { type: "object", properties: { ... } }
```

**Characteristics:**

- External service integration
- Structured input/output contracts
- Authentication and timeout handling
- Optional post-processing with LLM prompts

## Implementation Benefits

### Developer Experience

- **Natural language job creation** removes YAML/DSL learning curve
- **Entity recognition** provides autocomplete and validation
- **Visual feedback** shows recognized components
- **Structured output** maintains precision and debuggability

### Platform Benefits

- **Separation of concerns** between Atlas logic and user configuration
- **Multi-agent support** enables diverse integration patterns
- **M:M signal-job relationships** support complex workflow scenarios
- **Reusable jobs** can be shared across workspaces and teams

### Operational Benefits

- **Clear audit trail** from natural language to structured execution
- **Version control** for all configuration components
- **Testing support** through manual job triggering
- **Debugging visibility** through structured job specifications

## Migration Path

1. **Atlas.yml Creation**: Extract supervisor logic from existing workspace configurations
2. **Job Extraction**: Convert existing signal mappings to dedicated job files
3. **Natural Language Interface**: Build entity recognition and structured generation
4. **Backward Compatibility**: Support existing workspace.yml format during transition
5. **Gradual Migration**: Allow workspaces to adopt new patterns incrementally

## Future Enhancements

- **Job Templates**: Common patterns (PR review, deployment, monitoring) as reusable templates
- **Cross-Workspace Sharing**: Job marketplace for common enterprise patterns
- **Advanced Conditions**: ML-based condition inference from natural language
- **Performance Optimization**: Caching and parallel execution improvements
- **Workflow Integration**: Integration with existing CI/CD and project management tools

## Working Examples

### Telephone Game Workspace

**File: `examples/workspaces/telephone/workspace.yml`**

```yaml
version: "1.0"

workspace:
  id: "7821d138-71a6-434c-bc64-10addcf33532"
  name: "Multi-Provider Telephone Game"
  description: "Message transformation through sequential agent processing"

# Signal definitions
signals:
  telephone-message:
    description: "Trigger a telephone game with a message"
    provider: "http"
    path: "/telephone"
    method: "POST"

# Job definitions
jobs:
  telephone:
    name: "telephone"
    description: "Sequential message transformation workflow"
    triggers:
      - signal: "telephone-message"
        condition: {
          "and": [{ "var": "message" }, { ">": [{ "length": { "var": "message" } }, 0] }],
        }
    execution:
      strategy: "sequential"
      agents:
        - id: "mishearing-agent"
          input_source: "signal"
        - id: "embellishment-agent"
          input_source: "previous"
        - id: "reinterpretation-agent"
          input_source: "previous"

# Agent definitions
agents:
  mishearing-agent:
    type: "llm"
    model: "claude-3-5-haiku-latest"
    purpose: "Specializes in phonetic errors and mishearing transformations"

  embellishment-agent:
    type: "llm"
    model: "claude-3-5-haiku-latest"
    purpose: "Adds creative details and context to messages"

  reinterpretation-agent:
    type: "llm"
    model: "claude-3-5-haiku-latest"
    purpose: "Dramatically transforms and reinterprets messages"
```

### Atlas Codebase Analyzer

**File: `examples/workspaces/atlas-codebase-analyzer/workspace.yml`**

```yaml
version: "1.0"

workspace:
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  name: "Atlas Codebase Analyzer"
  description: "Autonomous Atlas codebase analysis for performance and DX improvements"

signals:
  manual-analysis:
    provider: "http"
    path: "/analyze"
    method: "POST"

jobs:
  comprehensive-analysis:
    name: "comprehensive-analysis"
    description: "Complete Atlas codebase analysis covering performance, DX, and architecture"
    triggers:
      - signal: "manual-analysis"
        condition: {
          "or": [{ "!": { "var": "type" } }, { "==": [{ "var": "type" }, "comprehensive"] }],
        }
    execution:
      strategy: "sequential"
      context:
        codebase_files:
          - "src/core/workspace-runtime.ts"
          - "src/core/session-supervisor.ts"
          - "src/core/workers/"
        focus_areas:
          - "Worker architecture and communication patterns"
          - "XState FSM implementations"
          - "Signal processing and session lifecycle"
      agents:
        - id: "performance-analyzer"
          input_source: "codebase_context"
        - id: "dx-analyzer"
          input_source: "codebase_context"
        - id: "architecture-analyzer"
          input_source: "codebase_context"
        - id: "report-generator"
          input_source: "combined"

agents:
  performance-analyzer:
    type: "llm"
    model: "claude-3-7-sonnet-latest"
    purpose: "Deep performance analysis and optimization recommendations"

  dx-analyzer:
    type: "llm"
    model: "claude-3-7-sonnet-latest"
    purpose: "Developer experience analysis and improvement recommendations"
```

### Key Configuration Patterns

#### Condition Syntax (JSONLogic)

```yaml
# Simple existence check
condition: { "var": "message" }

# String length validation
condition: { "and": [{ "var": "message" }, { ">": [{ "length": { "var": "message" } }, 0] }] }

# Multiple conditions with OR
condition: { "or": [{ "!": { "var": "type" } }, { "==": [{ "var": "type" }, "comprehensive"] }] }

# Complex nested conditions
condition: {
  "and": [
    { "var": "action" },
    { "in": [{ "var": "action" }, ["create", "update"]] },
    { ">": [{ "length": { "var": "description" } }, 10] },
  ],
}
```

#### Input Source Options

```yaml
agents:
  - id: "first-agent"
    input_source: "signal" # Use original signal payload
  - id: "second-agent"
    input_source: "previous" # Use output from previous agent
  - id: "analyzer"
    input_source: "codebase_context" # Load specified codebase files
  - id: "synthesizer"
    input_source: "combined" # Combine all previous outputs
```

#### Execution Strategies

```yaml
execution:
  strategy: "sequential" # Execute agents one after another
  # OR
  strategy: "parallel" # Execute all agents simultaneously
```
