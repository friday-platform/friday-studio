# Conversation Agent Rebalancing Plan

## Update: Nuclear Option - Complete Rewrite

Instead of patching a 450+ line workspace-obsessed prompt, we're starting fresh with a minimal 150-line prompt that embodies the new philosophy from the ground up.

### Comparison: Old vs New

**Original prompt.txt**:
- 457 lines
- 200+ lines about workspace creation
- 50+ lines about MCP server discovery  
- Complex multi-phase information gathering
- "Workspace Orchestrator" identity
- Aggressive automation pushing

**New minimal prompt**:
- 150 lines (67% reduction)
- 15 lines about workspace creation
- 0 lines about MCP discovery (handled at runtime)
- Simple clarify → execute → deliver flow
- "Task Executor" identity
- Gentle automation suggestions

### What We're Cutting

1. **Entire sections removed**:
   - workspace_creation_confirmation (75 lines)
   - information_gathering_strategy (60 lines)
   - library_streaming_guidance (30 lines)
   - mcp_server_discovery (40 lines)
   - resource_knowledge (40 lines)

2. **Concepts simplified**:
   - Todo memory: 50 lines → 5 lines
   - Communication approach: 40 lines → integrated naturally
   - Examples: 80 lines → 30 focused examples

3. **Workspace-first bias eliminated**:
   - No more "I'll create a workspace that..."
   - No more pattern matching for immediate workspace creation
   - No more extensive confirmation flows

### What We're Keeping (Refined)

1. **User-loved features**:
   - Clarifying questions (but only quality-impacting ones)
   - Plan summarization before execution
   - User control via confirmation

2. **Core capabilities**:
   - Direct agent invocation via MCP
   - Todo memory for context
   - Workspace creation (when appropriate)

3. **Personality**:
   - Direct, helpful, technical when needed
   - No marketing speak
   - Results-focused

## Current State Analysis

The conversation agent is currently optimized for workspace creation as the primary interaction model. This creates friction for new users who want to see Atlas solve their immediate problem before committing to automation.

### Key Problems with Current Approach

1. **Workspace-First Mentality** (lines 6-17 of prompt.txt)
   - Agent identifies as "workspace orchestrator" 
   - Immediately pushes users toward workspace creation
   - Treats direct agent invocation as secondary

2. **Aggressive Automation Push** (lines 107-117)
   - Pattern matching immediately triggers workspace creation guide
   - Users asking "monitor/track/watch" get pushed to workspaces
   - No room for exploratory or one-off tasks

3. **Confirmation Fatigue** (lines 239-314)
   - Extensive workspace confirmation flows
   - Multiple steps before user sees any value
   - High commitment threshold for simple tasks

4. **Missing Direct Execution Path**
   - Agent has access to other agents via MCP (lines 179-224 in conversation.agent.ts)
   - But prompt heavily discourages using them directly
   - No guidance on when to execute vs. when to create workspaces

## Proposed New Journey

### Phase 1: Smart Clarification + Immediate Execution
**Goal**: Gather quality-impacting requirements, then deliver value immediately

- User: "I need to research competitors for my startup"
- Atlas: Asks clarifying questions that impact result quality
- Summarizes plan and waits for user acknowledgement
- Executes targeted-research agent after confirmation
- Delivers results quickly
- No mention of workspaces or automation

### Phase 2: Gentle Automation Discovery  
**Goal**: Plant the seed of recurring value

- After delivering results successfully
- Atlas: "I can also monitor these competitors weekly and alert you to changes. Interested?"
- Only if user shows interest, proceed to Phase 3

### Phase 3: Workspace Creation
**Goal**: Convert proven value into automation

- Guide through workspace creation
- Pre-populate with what worked in Phase 1
- Maintain existing confirmation flows

## Implementation Strategy

### 1. Prompt Restructuring

#### Remove Workspace-First Identity
```diff
- You're the natural language interface to Atlas's capabilities...
- **Your Role: Workspace Orchestrator**
- You are NOT a direct tool executor - you are a workspace orchestrator.
+ You're the natural language interface to Atlas's capabilities...
+ **Your Role: Task Executor & Automation Guide**
+ You DIRECTLY execute tasks through agents, then guide users to automation when valuable.
```

#### Add Direct Execution Guidelines
```text
<direct_execution_principles>
# Clarification Strategy (Two-Tier Questions)
**Phase 1 Questions (Ask before execution):**
- Impact result quality or accuracy
- Define search/analysis parameters  
- Clarify ambiguous requirements
- Determine success criteria
Always present plan and wait for user acknowledgement before executing.

**Phase 2 Questions (Ask only if automating):**
- Monitoring frequency
- Notification channels  
- Trigger conditions
- Schedule preferences

# When to Execute Directly (Default Path)
- User has an immediate need ("research X", "analyze Y", "find Z")
- Task is exploratory or investigative
- User hasn't committed to recurring execution
- First interaction with a new capability

# When to Suggest Workspaces (After Success)
- Task completed successfully via direct execution
- Clear recurring pattern exists (daily/weekly/triggered)
- User expresses interest in automation
- Multiple related tasks could be bundled

# Transition Patterns
After successful execution:
"I found [results]. Would you like me to check for updates [frequency]?"
"This analysis worked well. I can run similar checks automatically when [trigger]."
"Got it done. Want to automate this for [use case]?"
</direct_execution_principles>
```

### 2. Pattern Recognition Changes

#### Current (Aggressive)
```text
Pattern: "monitor/track/watch [anything]" → workspace creation
```

#### Proposed (Progressive)
```text
Pattern: "monitor/track/watch [anything]" → 
1. Execute immediate check/search
2. Show results
3. "I can keep monitoring this for you. How often would you like updates?"
```

### 3. Tool Context Reframing

#### Current (Confusing)
```text
**Your tools**: atlas_workspace_*, atlas_todo_*
**Workspace tools**: atlas_notify_email, targeted_research, atlas_bash
```

#### Proposed (Clear)
```text
**Direct Execution Tools**: All agents available via MCP
- targeted_research: Web research and data gathering
- [other agents]: [capabilities]

**Automation Tools**: atlas_workspace_*
- Used AFTER proving value with direct execution
- Creates recurring/triggered automations
```

### 4. Critical Section Updates

#### Information Gathering (lines 148-206)
```diff
- Ask clarifying questions about genuinely ambiguous requirements
+ Ask clarifying questions that impact result quality
+ Present execution plan and wait for user acknowledgement
+ Execute only after user confirms or clarifies
```

#### Example Interactions (lines 342-424)
Add new examples showing the clarification-then-execution flow:

**Example 1: Research Task**
```text
User: "Research AI startups in healthcare"

Atlas: "I'll help you research AI healthcare startups. A few questions to find the most relevant ones:
1. Any specific healthcare verticals? (diagnostics, drug discovery, patient care, etc.)
2. Funding stage preference? (seed, Series A+, all stages)
3. Geographic focus? (US, global, specific regions)

I'll search for AI healthcare startups and provide company profiles, funding details, and key differentiators."

User: "Focus on diagnostics, Series A or later, US-based"

Atlas: [Invokes targeted_research agent]
"Found 15 AI diagnostic startups with Series A+ funding. Here are the key players...
[Results shown]

I can monitor for new entrants or funding rounds weekly if you'd like. Interested?"
```

**Example 2: Data Gathering Task**
```text
User: "Find Airbnbs in Mexico City for a bachelor party"

Atlas: "I'll help find bachelor party Airbnbs in Mexico City. Quick questions for the best matches:
1. How many guests?
2. Budget per night?
3. Which neighborhoods, or should I focus on nightlife areas?
4. Any must-have amenities? (pool, rooftop, etc.)

I'll search for group-friendly properties with good reviews and party-suitable layouts."

User: "10 people, under $500/night, near nightlife, rooftop would be great"

Atlas: [Executes search]
"Found 8 properties in Roma Norte and Condesa that fit your criteria...
[Results shown]

Want me to track these for price drops or new listings through your trip dates?"
```

## Question Classification Framework

### Quality-Impacting Questions (Ask Before Execution)
Questions that directly affect the results Atlas will deliver:
- **Scope**: "Which competitors?" "What neighborhoods?" "Which metrics?"
- **Criteria**: "Budget range?" "Must-have features?" "Deal breakers?"
- **Context**: "Industry?" "Use case?" "Team size?"
- **Preferences**: "Output format?" "Level of detail?" "Focus areas?"

### Automation-Specific Questions (Ask Only After Success)
Questions that only matter for recurring execution:
- **Schedule**: "How often?" "What time?" "Which days?"
- **Notifications**: "Email or Discord?" "Who should receive alerts?"
- **Triggers**: "What should trigger this?" "Threshold values?"
- **Persistence**: "Keep history?" "Archive old results?"

### Exceptions: Direct-to-Workspace Patterns
Some requests clearly indicate automation intent from the start:
- "Send me a daily report of..."
- "Alert me every time..."
- "Schedule a weekly check of..."
- "Monitor continuously for..."

For these, it's acceptable to include scheduling questions upfront, but still execute once first to prove value before creating the workspace.

## Success Metrics

1. **Time to First Value**: How quickly users see results after clarification (target: <60 seconds)
2. **Workspace Conversion Rate**: % of successful executions that become workspaces
3. **User Satisfaction**: Measured through successful task completion
4. **Clarification Efficiency**: Questions answered vs questions asked ratio

## Risk Analysis

### Risk 1: Users Never Discover Automation
**Mitigation**: After 2-3 successful direct executions of similar tasks, be more proactive about automation benefits

### Risk 2: Increased Complexity in Prompt
**Mitigation**: Create clear decision trees and examples, remove workspace-heavy sections

### Risk 3: Resource Usage from Direct Execution
**Mitigation**: This is actually MORE efficient - only successful patterns become workspaces

## Specific Prompt.txt Changes Required

### Lines to Remove/Replace
- **Lines 6-17**: Remove "Workspace Orchestrator" identity
- **Lines 107-117**: Remove aggressive automation pattern matching  
- **Lines 239-314**: Simplify workspace confirmation (move to post-execution)
- **Lines 343-361**: Remove workspace-first examples

### Lines to Add
- **After line 5**: New identity as "Task Executor & Automation Guide"
- **New section after line 68**: Direct execution principles with two-tier questions
- **New section after line 200**: Execute-first examples
- **New section before workspace_creation_confirmation**: Direct execution flow

### Lines to Modify
- **Lines 148-206**: Change from "silent understanding" to "clarify for quality"
- **Lines 10-12**: Change tool context from "Your tools vs Workspace tools" to "Direct Execution Tools vs Automation Tools"

## Migration Path

1. **Phase 1**: Update prompt.txt with new identity and direct execution principles
2. **Phase 2**: Add progressive disclosure patterns for workspace creation
3. **Phase 3**: Update example interactions to show new flow
4. **Phase 4**: Simplify workspace creation to focus on proven patterns
5. **Phase 5**: Test with real user scenarios and refine based on behavior

## Key Implementation Details

### Preserving User-Loved Features
- **Keep clarifying questions**: Users appreciate Atlas asking smart questions
- **Keep plan summarization**: Users want to know what Atlas will do before it does it
- **Keep confirmation step**: Users want control over execution
- **Remove workspace-first bias**: Stop pushing automation before showing value

### The New Flow
1. **Understand**: Parse request, identify task type
2. **Clarify**: Ask quality-impacting questions (NOT automation questions)
3. **Summarize**: "Here's what I'll do..." with specifics
4. **Confirm**: Wait for user go-ahead
5. **Execute**: Run the agent/task directly
6. **Deliver**: Show results immediately
7. **Suggest**: Gently offer automation if pattern fits

## Elements Potentially Missing from Minimal Version

### Critical Omissions to Consider

1. **Stream ID handling**: Original has specific logic for passing stream IDs to tools
   - **Impact**: May break signal triggers
   - **Solution**: Add minimal stream ID section if needed

2. **Atlas-specific tools**: No mention of atlas_workspace_*, atlas_todo_* tools
   - **Impact**: Agent might not know how to create workspaces
   - **Solution**: Add tool list or rely on runtime discovery

3. **Error handling**: No guidance on handling failures
   - **Impact**: Poor user experience when things break
   - **Solution**: Add minimal error response patterns

4. **Multi-agent coordination**: No guidance on chaining agents
   - **Impact**: Complex tasks might not work well
   - **Solution**: Test first, add if needed

5. **Rate limiting/resource management**: No mention of being efficient
   - **Impact**: Could hammer APIs unnecessarily  
   - **Solution**: Add if it becomes a problem

### Intentional Omissions (Good to Remove)

1. **MCP server discovery**: Overly complex, handle at runtime
2. **Library streaming**: Edge case, not core to new journey
3. **Environment variable collection**: Part of the problem we're solving
4. **Extensive workspace confirmation**: The whole point of this change
5. **Resource-first automation**: Too aggressive

### Things We Can Add Back If Needed

The beauty of starting minimal is we can add back only what proves necessary through testing, rather than carrying forward all the cruft.

## Critical Analysis - Red Team Assessment

### Potential Failure Modes

1. **Prompt Complexity Explosion**
   - Adding more rules to an already 450+ line prompt
   - Risk: Agent becomes unpredictable or ignores newer instructions
   - Mitigation: Remove workspace-heavy sections rather than just adding new ones

2. **Context Loss Problem**  
   - When users don't automate, we lose their preferences
   - Example: User researches "AI startups in diagnostics" weekly but never automates
   - Each time they ask, Atlas has to re-clarify the same questions
   - Potential solution: Store "execution templates" separate from workspaces?

3. **Agent Invocation Limitations**
   - Assumes all agents can be called directly via MCP
   - Need to verify: Can conversation agent actually invoke targeted_research directly?
   - Code shows it CAN (lines 179-224) but are there hidden limitations?

4. **User Mental Model Mismatch**
   - Users coming from competitors might expect automation-first
   - Marketing might position Atlas as "automation platform"  
   - Risk: Confusion when Atlas doesn't immediately offer workspace creation
   - Mitigation: Clear onboarding that explains the journey

5. **The "Annoying Assistant" Problem**
   - Every successful task ends with "Want me to automate this?"
   - After 5 successful searches: Still asking "Want me to automate this?"
   - Risk: Users get annoyed by repetitive automation suggestions
   - Solution: Track declined suggestions, back off after 2-3 "no" responses

### What This Plan Ignores

1. **Error Handling**: What if direct execution fails? Do we still suggest automation?
2. **Partial Success**: Task works but not perfectly - automation suggestion seems premature
3. **Cost Implications**: Direct execution might be more expensive than deferred workspace execution
4. **Multi-Agent Tasks**: Some tasks might require multiple agents - how does clarification work?
5. **State Management**: How do we track what's been executed vs what's been automated?

### The Hardest Part

The most challenging aspect is **retraining the LLM's instincts**. The current prompt has deeply embedded workspace-creation patterns. Simply adding new instructions might not override these patterns effectively. We may need to:
- Remove/comment out large sections of workspace-focused content
- Add explicit "DO NOT create workspace until..." guards
- Provide many more execute-first examples

## Sample New Prompt Sections

### New Identity Section
```text
<identity>
You're Atlas, the AI assistant that helps users accomplish their goals through natural conversation.

**Your Role: Task Executor & Automation Guide**
You DIRECTLY execute tasks through specialized agents to solve immediate problems, then guide users toward automation when patterns emerge.

**Your Approach**:
1. Execute first - Show what Atlas can do immediately
2. Prove value - Deliver results before discussing automation  
3. Guide gently - Suggest workspaces after successful execution
4. Respect preferences - Some users want one-off tasks, not automation
</identity>
```

### New Direct Execution Section
```text
<direct_execution>
# Default Behavior: Execute Immediately

When users request tasks ("research X", "find Y", "analyze Z"):
1. Ask clarifying questions that impact result quality
2. Summarize what you'll do
3. Wait for confirmation
4. Execute using appropriate agents
5. Show results
6. THEN (and only then) suggest automation if appropriate

# DO NOT create workspaces before showing value
# DO NOT ask about schedules/frequencies before executing
# DO NOT push automation on exploratory tasks
</direct_execution>
```

## Implementation Decisions (Validated)

1. **Tracking similar requests**: No tracking for now - keep it simple

2. **Automation suggestion tone**: Gentle-to-moderate
   - Pattern: "Is this what you're looking for? If so, I can do this on a scheduled basis."
   - Gives users a chance to adjust output before workspace creation

3. **Direct-to-workspace patterns**: STILL show value first
   - Even "schedule X every day" should execute once
   - Show "here's what you'll get every day" before workspace creation
   - Exception: User explicitly says "just create the workspace"

4. **Proven value threshold**: Simply showing good results that meet needs

5. **"Don't ask questions" handling**: The user is right
   - Use reasonable defaults and execute immediately
   - Skip clarification phase entirely

6. **Preventing annoyance**: Gentle approach + value confirmation
   - "Is this what you're looking for?" before automation offer
   - Not repetitive because it's tied to value confirmation

7. **Storing preferences**: Atlas memory handles this automatically

## Final Minimal Prompt

The minimal prompt in `/docs/minimal-conversation-prompt.txt` incorporates all these decisions:
- 150 lines (67% reduction from original 457)
- Execute-first philosophy throughout
- Gentle automation suggestions after value confirmation
- Respects user preferences about questions
- Shows value even for obvious automation requests

## Key Insight: The Refinement Opportunity

The critical insight is that showing value first isn't just about proving Atlas works - it's about giving users a chance to refine what they want BEFORE automating it. 

When a user sees actual results, they can:
- Adjust search parameters ("Actually, include Series B companies too")
- Refine output format ("Can you group these by region?")
- Add missing criteria ("Also filter for companies with APIs")

This refinement opportunity is lost if we jump straight to workspace creation. The new flow ensures users automate exactly what they want, not what they initially asked for.