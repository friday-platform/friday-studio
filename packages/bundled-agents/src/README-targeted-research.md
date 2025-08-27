# Targeted Research Agent

Executes domain-specific web research with parallel searches, content extraction, and citation-backed synthesis.

## What It Does

Parses natural language queries into structured searches, executes them across targeted domains (Reddit, Airbnb, Stack Overflow), extracts full content from results, and synthesizes findings with proper citations.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                   PROCESSING PIPELINE                                │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐  │
│  │   PARSE    │ → │   SEARCH   │ → │  EVALUATE  │ → │  EXTRACT   │ → │ SYNTHESIZE │  │
│  └────────────┘   └────────────┘   └────────────┘   └────────────┘   └────────────┘  │
│        ↓                ↓                ↓                ↓                ↓         │
│   Query → Spec    Parallel APIs     LLM Scoring      Content Pull     Citation Gen   │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘

INPUT:  "Find Airbnb listings in Tokyo under $100/night"
        ↓
PARSE:  → {query: "Airbnb Tokyo under $100", domains: [], time_range: null}
        ↓
SEARCH: → Execute parallel queries with 3 retry attempts
        → Deduplicate results across attempts
        → Refine query if insufficient results
        ↓
EVAL:   → Score: 80% LLM confidence + 20% Tavily score
        → Process in batches of 5
        → Suggest improvements when <3 relevant
        ↓
EXTRACT:→ Pull content from top 15 URLs (5 per batch)
        → Fallback to snippets on failure
        → Summarize if >2000 tokens
        ↓
OUTPUT: → "Tokyo offers [budget options](url1) starting at [¥3000](url2)..."
        → Formats: summary | list | comparison
```

### Core Pipeline Functions

**`parseQuery()`** - Extracts search parameters using Claude Sonnet + Zod validation

- Converts "Find Airbnb listings in Tokyo under $100/night" → `{query: "Airbnb Tokyo under $100", include_domains: [], time_range: undefined}`
- Enforces 400 character limit per query
- Supports multiple parallel queries

**`searchWithRetries()`** - Executes searches with intelligent retry

- 3 attempts max with query refinement between retries
- Deduplicates results across attempts
- Emits progress via Atlas streaming

**`evaluateResults()`** - LLM-powered relevance scoring

- Processes results in batches of 5 to avoid API limits
- Blends Tavily score (20%) + LLM confidence (80%)
- Suggests query improvements when <3 relevant results found

**`extractTopResults()`** - Parallel content extraction

- Extracts up to 15 URLs in batches of 5
- Handles extraction failures gracefully
- Falls back to search snippets for failed extractions

**`synthesizeResults()`** - Generates final output

- Uses both extracted content and search snippets
- Creates proper [text](url) citations
- Formats as summary, list, or comparison based on query

## Atlas Integration

Built as an Atlas agent using `@atlas/agent-sdk`:

- **Input**: `{prompt: string}` - Natural language query
- **Output**: Research findings with source metrics and timing data
- **Streaming**: Progress updates via Atlas SSE
- **Error handling**: Detailed logging with Atlas logger

## Technical Details

### Models Used

- **Claude Sonnet**: Query parsing, result evaluation, query refinement, synthesis
- **Claude Haiku**: Content summarization only (for speed/cost)

### API Constraints

- **Query length**: 400 characters max (Tavily limit)
- **Extraction batch**: 5 URLs at once
- **Content limit**: 2000 tokens (summarized if larger)
- **Retry attempts**: 3 max with query modification

### Error Handling

- Individual result evaluation failures don't stop the pipeline
- Extraction failures fall back to search snippets
- Query refinement when results are insufficient
- Clear error messages with context

## Usage Examples

**Reddit Research**

```
"Recent r/homeautomation posts about smart locks"
→ Searches reddit.com/r/homeautomation for "smart locks" within past week
```

**Domain Comparison**

```
"Compare React vs Vue discussions on r/webdev"
→ Parallel searches for "React" and "Vue" within reddit.com/r/webdev
→ Synthesis compares findings side-by-side
```

**Travel Planning**

```
"Find Airbnbs in Tokyo under $100/night"
→ Searches for "Airbnb Tokyo under $100" across relevant domains
```

**Real Estate Search**

```
"Houses under $500k in Austin on Zillow"
→ Searches zillow.com for "houses under $500k Austin" with property filters
```

## Setup

1. Set `TAVILY_API_KEY` environment variable
2. Agent auto-registers with Atlas at startup
3. Call via Atlas workspace: `agents.call("targeted-research", {prompt: "your query"})`

## Output Format

```typescript
{
  query: string,                    // Original query
  synthesis: string,                // Findings with [text](url) citations
  sources: {
    searchResults: number,          // Total search results found
    extractedCount: number,         // Successfully extracted pages
    failedExtractions: number,      // Failed extractions (fell back to snippets)
    relevantResults: number         // LLM-filtered relevant results
  },
  timing: {
    total: number,                  // Total execution time (ms)
    parse: number,                  // Query parsing time
    search: number,                 // Search execution time
    extract: number,                // Content extraction time
    synth: number                   // Synthesis time
  }
}
```
