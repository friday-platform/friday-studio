```mermaid
graph TD
    subgraph "Session Flow"
        Start[Session Start] --> LoadMem[Load Memory Context]
        LoadMem --> Process[Process Current Task]
        Process --> StoreMem[Store Memory]
        StoreMem --> End[Session End]
    end

    subgraph "Memory Types"
        Working[WORKING Memory<br/>Short-term, active processing]
        Episodic[EPISODIC Memory<br/>Specific experiences/events]
        Semantic[SEMANTIC Memory<br/>General knowledge/concepts]
        Procedural[PROCEDURAL Memory<br/>How-to knowledge/skills]
    end

    subgraph "Memory Operations"
        Read[Read Operation]
        Write[Write Operation]
        Consolidate[Consolidation]
    end

    %% Session Start Operations
    Start --> LoadMem
    LoadMem --> Read
    Read --> Working
    Read --> Episodic
    Read --> Semantic
    Read --> Procedural

    %% Processing Operations
    Process --> Write
    Write --> Working

    %% Memory Consolidation
    Working --> Consolidate
    Consolidate --> Episodic
    Consolidate --> Semantic

    %% Session End Operations
    StoreMem --> Write
    Write --> Episodic
    Write --> Semantic

    %% Memory Type Characteristics
    Working -.-> |"Session-specific<br/>Temporary"| Working
    Episodic -.-> |"Workspace-shared<br/>Persistent"| Episodic
    Semantic -.-> |"Workspace-shared<br/>Persistent"| Semantic
    Procedural -.-> |"Workspace-shared<br/>Read-only"| Procedural

    %% Memory Access Patterns
    Working -.-> |"Read/Write"| Working
    Episodic -.-> |"Read/Write"| Episodic
    Semantic -.-> |"Read/Write"| Semantic
    Procedural -.-> |"Read-only"| Procedural

    %% Memory Retention
    Working -.-> |"Max Age: 24h<br/>Max Entries: 100"| Working
    Episodic -.-> |"Max Age: 90d<br/>Max Entries: 1000"| Episodic
    Semantic -.-> |"Max Age: 365d<br/>Max Entries: 2000"| Semantic
    Procedural -.-> |"Max Age: 365d<br/>Max Entries: 500"| Procedural

    style Working fill:#ffd700,stroke:#333,stroke-width:2px
    style Episodic fill:#90ee90,stroke:#333,stroke-width:2px
    style Semantic fill:#87ceeb,stroke:#333,stroke-width:2px
    style Procedural fill:#dda0dd,stroke:#333,stroke-width:2px
    style Read fill:#f0f0f0,stroke:#333,stroke-width:2px
    style Write fill:#f0f0f0,stroke:#333,stroke-width:2px
    style Consolidate fill:#f0f0f0,stroke:#333,stroke-width:2px
```

# Memory Model Flow Documentation

## Memory Types

1. **WORKING Memory**
   - Short-term, active processing of current session
   - Session-specific and temporary
   - Read/Write access
   - Max Age: 24 hours
   - Max Entries: 100

2. **EPISODIC Memory**
   - Specific experiences and events
   - Workspace-shared and persistent
   - Read/Write access
   - Max Age: 90 days
   - Max Entries: 1000

3. **SEMANTIC Memory**
   - General knowledge and concepts
   - Workspace-shared and persistent
   - Read/Write access
   - Max Age: 365 days
   - Max Entries: 2000

4. **PROCEDURAL Memory**
   - How-to knowledge and skills
   - Workspace-shared and read-only
   - Read-only access
   - Max Age: 365 days
   - Max Entries: 500

## Memory Operations

1. **Read Operation**
   - Occurs at session start
   - Loads relevant context from all memory types
   - Used to inform current session processing

2. **Write Operation**
   - Occurs during session processing
   - Primarily writes to WORKING memory
   - At session end, writes to EPISODIC and SEMANTIC memory

3. **Consolidation**
   - Moves important WORKING memories to long-term storage
   - Based on access count (>3) or relevance score (>0.8)
   - Converts to EPISODIC or SEMANTIC memory

## Session Flow

1. **Session Start**
   - Loads memory context from all memory types
   - Prepares working memory for current session

2. **Processing**
   - Uses working memory for active processing
   - May read from other memory types as needed

3. **Memory Storage**
   - Stores session learnings in appropriate memory types
   - Consolidates important working memories

4. **Session End**
   - Finalizes memory storage
   - Prepares for next session
