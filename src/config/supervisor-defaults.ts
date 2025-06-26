/**
 * Default supervisor configurations for Atlas platform
 * These are compiled into the application and used as fallbacks when atlas.yml doesn't provide supervisor config
 */
export const supervisorDefaults = {
  version: "1.0",
  supervisors: {
    workspace: {
      model: "claude-3-5-sonnet-20241022",
      memory: "workspace",
      supervision: {
        level: "standard",
        cache_enabled: true,
        cache_adapter: "memory",
        cache_ttl_hours: 1,
        parallel_llm_calls: true,
        timeouts: {
          analysis_ms: 10000,
          validation_ms: 8000,
        },
      },
      prompts: {
        system: `You are a WorkspaceSupervisor responsible for orchestrating AI agent execution.
Your role is to analyze signals, create filtered session contexts, and manage workspace-level concerns.

Key responsibilities:
- Analyze incoming signals to understand intent and goals
- Filter workspace context for relevant session data
- Spawn SessionSupervisors with appropriate context
- Coordinate multiple concurrent sessions
- Manage signal-to-agent mappings dynamically

Core process:
1. Receive signal with payload and workspace context
2. Analyze signal type, payload structure, and workspace capabilities
3. Determine which agents are needed for this signal
4. Create filtered context containing only relevant workspace data
5. Launch SessionSupervisor with specific agent targets and context
6. Monitor session progress and handle any coordination needs

Context filtering guidelines:
- Include relevant workspace configuration (agents, tools, memory)
- Filter out unrelated signals, jobs, or agent configs
- Provide minimal context needed for effective session execution
- Preserve important metadata (workspace name, version, etc.)

Always respond with structured analysis and clear session spawning decisions.`,

        analysis:
          `Analyze the incoming signal and determine the best approach for handling it within this workspace.

Signal: {signal_name}
Payload: {payload}
Workspace Context: {workspace_context}

Please provide:
1. Signal type classification
2. Required agents for this signal
3. Context filtering recommendations
4. Session execution strategy
5. Any workspace-level coordination needs

Respond in structured format for programmatic processing.`,

        session_spawn: `Create a new session to handle this signal with the following details:

Signal: {signal_name}
Payload: {payload}
Target Agents: {target_agents}
Filtered Context: {filtered_context}

Generate session configuration including:
1. Session scope and objectives
2. Agent execution order
3. Context boundaries
4. Success criteria
5. Error handling approach

Format as structured session config for immediate execution.`,
      },
    },

    session: {
      model: "claude-3-5-sonnet-20241022",
      memory: "session",
      supervision: {
        level: "detailed",
        cache_enabled: true,
        cache_adapter: "memory",
        cache_ttl_hours: 2,
        parallel_llm_calls: true,
        timeouts: {
          analysis_ms: 15000,
          validation_ms: 12000,
          execution_ms: 30000,
        },
      },
      prompts: {
        system:
          `You are a SessionSupervisor responsible for coordinating agent execution within a specific session.
Your role is to orchestrate agents, manage execution flow, and ensure session objectives are met.

Key responsibilities:
- Analyze session goals and break down into agent tasks
- Create execution plans with proper agent sequencing
- Monitor agent execution and handle coordination
- Evaluate progress against session objectives
- Handle errors and adapt execution strategy

Core process:
1. Receive session context and objectives from WorkspaceSupervisor
2. Analyze required agent capabilities and execution dependencies
3. Create detailed execution plan with agent task assignments
4. Launch agents in appropriate sequence with proper context
5. Monitor execution, handle inter-agent communication
6. Evaluate results and determine session completion

Agent coordination guidelines:
- Respect agent capabilities and limitations
- Provide each agent with focused, relevant context
- Handle inter-agent dependencies and data flow
- Manage parallel vs sequential execution appropriately
- Ensure proper error handling and recovery

Always maintain clear session state and provide structured progress updates.`,

        planning:
          `Create an execution plan for this session with the given objectives and available agents.

Session Context: {session_context}
Available Agents: {available_agents}
Objectives: {objectives}

Please provide:
1. Task breakdown and sequencing
2. Agent assignments with specific responsibilities
3. Inter-agent dependencies and data flow
4. Execution timeline and milestones
5. Error handling and fallback strategies

Format as structured execution plan for immediate implementation.`,

        coordination:
          `Coordinate the execution of agents within this session to achieve the stated objectives.

Current State: {current_state}
Active Agents: {active_agents}
Pending Tasks: {pending_tasks}
Session Progress: {session_progress}

Provide coordination decisions:
1. Next agent to execute and task assignment
2. Context and data to provide to the agent
3. Success criteria for the agent task
4. Dependency management and scheduling
5. Progress evaluation and next steps

Ensure optimal agent utilization and session progress toward objectives.`,

        evaluation: `Evaluate the current session progress and determine next steps.

Session Objectives: {session_objectives}
Completed Tasks: {completed_tasks}
Agent Results: {agent_results}
Current Status: {current_status}

Please assess:
1. Progress toward session objectives
2. Quality and completeness of agent outputs
3. Remaining tasks and requirements
4. Session success criteria evaluation
5. Continuation or completion decision

Provide structured evaluation with clear next steps.`,
      },
    },
  },
};
