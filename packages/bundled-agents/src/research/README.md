# Research Agent

Does parallelized web research using supervisor-subagent orchestration. Currently uses Tavily as the search provider.

## Architecture

### Supervisor Pattern

A lead researcher (Sonnet 4) breaks down research questions into parallel tasks and delegates them to sub-agents (Haiku). Each sub-agent searches independently, stores results, then returns a synthesis. The supervisor reviews results and decides if more research is needed.

This parallelization cuts research time by 3-5x compared to sequential searches.

### Key Files

- `lead-researcher.ts` - Supervisor that orchestrates parallel research
- `sub-researcher.ts` - Worker that executes individual search tasks
- `memory-store.ts` - Session storage for summaries and raw data
- `tools/search-tools.ts` - Tavily API integration with auto-summarization
- `final-report-generator.ts` - Combines all research into markdown report

## How It Works

1. **Depth Detection**: Haiku analyzes the prompt to determine research depth (quick/standard/deep) and cleans up the research question. This sets how many searches each sub-agent performs.

2. **Parallel Execution**: The supervisor spawns 1-5 sub-agents based on the question. Each gets a specific topic and depth level:

   ```typescript
   conductResearch({ topic: "React performance", depth: "standard" });
   conductResearch({ topic: "Vue performance", depth: "standard" });
   ```

3. **Auto-Summarization**: Each Tavily search result is immediately summarized by Haiku (200-400 words). Raw data stored separately for citations.

4. **Completion Detection**: Supervisor reviews all syntheses, identifies gaps, delegates more research if needed, calls `researchComplete` when done.

5. **Report Generation**: Final agent pulls all summaries from memory, extracts URLs from raw data, generates markdown with citations.

## Design Decisions

### Why Supervisor-Subagent?

Parallel execution without context bleeding between searches. Each sub-agent has a clean context for its specific research topic.

### Why Auto-Summarization?

Web content is verbose. Summarizing immediately after each search lets us process 10x more sources within context limits. Haiku is fast and cheap for this task.

### Why Variable Depth?

Meeting prep doesn't need the same thoroughness as technical analysis. Depth detection optimizes search count automatically based on intent.

### Why Session Memory?

Decouples search from synthesis. The supervisor doesn't need to track raw data - it just orchestrates. The report generator pulls everything from memory when needed.

## Configuration

### Models

- **Supervisor**: Sonnet 4 (orchestration needs reasoning)
- **Sub-agents**: Haiku (fast for bulk searches)
- **Report Generator**: Haiku (synthesis of preprocessed data)

### Depth Configuration

```typescript
{
  quick: { maxSearches: 1, maxTasks: 3 },
  standard: { maxSearches: 2, maxTasks: 4 },
  deep: { maxSearches: 4, maxTasks: 5 }
}
```

### Examples

- **Quick**: "Who am I meeting from Anthropic?" → 1 sub-agent, 1 search
- **Standard**: "Research quantum computing applications" → 2-3 sub-agents, 2 searches each
- **Deep**: "Deep dive comparing React, Vue, and Angular" → 3 sub-agents, 4 searches each
