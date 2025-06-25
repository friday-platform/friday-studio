# Atlas Supervisor Hallucination Test Suite

This directory contains the comprehensive hallucination testing framework for Atlas supervisors, implementing systematic detection and validation of LLM-based decision-making accuracy.

## Directory Structure

```
tests/hallucination/
├── README.md                    # This file
├── framework/                   # Core test framework
│   ├── base-test.ts            # Base test class and interfaces
│   ├── test-runner.ts          # Test execution engine
│   ├── test-registry.ts        # Test registration and discovery
│   └── evaluation-engine.ts    # Metrics calculation and scoring
├── detectors/                   # Hallucination detection systems
│   ├── factual-detector.ts     # Factual accuracy validation
│   ├── context-detector.ts     # Context adherence checking
│   ├── consistency-detector.ts # Logical consistency validation
│   ├── safety-detector.ts      # Security and safety validation
│   └── capability-detector.ts  # Capability boundary checking
├── scenarios/                   # Test scenarios by supervisor type
│   ├── workspace-supervisor/    # WorkspaceSupervisor tests
│   ├── session-supervisor/      # SessionSupervisor tests
│   ├── agent-supervisor/        # AgentSupervisor tests
│   └── integration/            # Cross-supervisor integration tests
├── fixtures/                    # Test data and mock objects
│   ├── canary-traps.ts         # Canary trap definitions
│   ├── test-workspaces.ts      # Test workspace configurations
│   ├── mock-signals.ts         # Mock signal definitions
│   └── reference-data.ts       # Ground truth reference data
└── utils/                       # Testing utilities
    ├── test-helpers.ts          # Common test utilities
    ├── assertion-utils.ts       # Custom assertion functions
    └── report-generator.ts      # Test report generation
```

## Quick Start

### Running Tests

```bash
# Run all hallucination tests
deno test tests/hallucination/

# Run specific test category
deno test tests/hallucination/scenarios/workspace-supervisor/

# Run with detailed reporting
deno test tests/hallucination/ --reporter=verbose

# Run with hallucination metrics
deno task test:hallucination
```

### Key Features

1. **Canary Trap Strategy**: Systematic introduction of fictitious data to test context adherence
2. **Multi-Dimensional Evaluation**: Accuracy, consistency, safety, and capability boundary testing
3. **Automated Detection**: Real-time hallucination detection during test execution
4. **Comprehensive Coverage**: All critical supervisor decision points tested
5. **Production Integration**: Monitoring hooks for continuous validation

## Test Categories

### 1. Factual Accuracy Tests
- Verify decisions based on correct facts
- Detect world knowledge contamination
- Validate information source attribution

### 2. Context Adherence Tests  
- Ensure use of provided context over external knowledge
- Detect context over-filtering or under-utilization
- Validate context boundary respect

### 3. Logical Consistency Tests
- Check decision consistency across similar scenarios
- Detect contradictory reasoning patterns
- Validate temporal consistency

### 4. Safety & Security Tests
- Verify security policy compliance
- Detect risk assessment inaccuracies
- Validate safety boundary enforcement

### 5. Capability Boundary Tests
- Ensure accurate capability assessment
- Detect overconfidence in system abilities
- Validate resource constraint recognition

## Integration with Existing Tests

This framework is designed to complement, not replace, existing Atlas tests:

- **Isolation**: All tests run in separate namespace to avoid conflicts
- **Parallel Execution**: Can run alongside existing test suites
- **Shared Utilities**: Reuses existing test helpers and mocks where appropriate
- **CI/CD Integration**: Plugs into existing testing pipeline

## Metrics & Reporting

Each test generates comprehensive metrics:
- **Hallucination Detection Rate**: % of hallucinations successfully identified
- **False Positive Rate**: % of valid decisions incorrectly flagged
- **Decision Accuracy Score**: Overall correctness of supervisor decisions
- **Context Adherence Score**: Degree of context vs. world knowledge usage
- **Safety Compliance Rate**: % of decisions meeting security requirements

## Contributing

When adding new hallucination tests:

1. Extend appropriate base test classes
2. Include canary traps for context validation
3. Define clear expected vs. forbidden behaviors
4. Add comprehensive assertions with custom error messages
5. Update test registry for automatic discovery

## Implementation Status

- [x] Framework design and architecture
- [x] Directory structure creation
- [ ] Base framework implementation
- [ ] Detector system implementation
- [ ] Sample test scenarios
- [ ] Integration with CI/CD pipeline
- [ ] Production monitoring hooks