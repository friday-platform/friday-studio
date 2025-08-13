# Tavily Web Search Tools

This module provides AI-powered web search, content extraction, and crawling capabilities using
Tavily's advanced search engine. These tools are designed for comprehensive web research and content
analysis workflows.

## Architecture

**API-Based Design:**

- Direct integration with Tavily's REST API
- No browser automation overhead
- High-performance search with AI-enhanced results
- Built-in content extraction and summarization

## Available Tools

### Web Search

#### `tavily_search`

Performs AI-powered web searches with intelligent content filtering and summarization.

```typescript
// Basic web search
{
  "query": "latest AI developments 2024",
  "max_results": 10,
  "include_answer": true
}

// News-specific search
{
  "query": "company layoffs",
  "topic": "news",
  "days": 7,
  "search_depth": "advanced"
}

// Domain-filtered search
{
  "query": "JavaScript frameworks",
  "include_domains": ["github.com", "stackoverflow.com"],
  "exclude_domains": ["spam-site.com"]
}
```

**Parameters:**

- `query` (required): Search query string
- `search_depth`: "basic" or "advanced" (default: "basic")
- `topic`: "general" or "news" (default: "general")
- `days`: Number of recent days for news searches
- `max_results`: 1-20 results (default: 5)
- `include_domains`: Array of domains to include
- `exclude_domains`: Array of domains to exclude
- `include_answer`: Include AI-generated summary (default: false)
- `include_raw_content`: Include full page content (default: false)
- `include_images`: Include images in results (default: false)

#### `tavily_extract`

Extracts and processes content from specific URLs with AI-enhanced parsing.

```typescript
{
  "urls": [
    "https://example.com/article1",
    "https://example.com/article2"
  ],
  "include_raw_content": true
}
```

**Parameters:**

- `urls` (required): Array of URLs to extract content from
- `include_raw_content`: Include raw text extraction (default: true)

#### `tavily_crawl`

Crawls websites systematically to discover and extract content from multiple pages.

```typescript
{
  "url": "https://docs.example.com",
  "max_depth": 2,
  "exclude_domains": ["ads.example.com"],
  "include_raw_content": true
}
```

**Parameters:**

- `url` (required): Starting URL for crawling
- `max_depth`: Crawling depth 1-3 (default: 1)
- `exclude_domains`: Domains to skip during crawling
- `include_raw_content`: Include full content extraction (default: true)

## Setup and Authentication

### Environment Variables

Set your Tavily API key:

```bash
export TAVILY_API_KEY="tvly-your-api-key-here"
```

Get your API key from [Tavily Dashboard](https://app.tavily.com/).

### Atlas Integration

Configure in your workspace.yml:

```yaml
tools:
  mcp:
    servers:
      atlas-platform:
        transport:
          type: "http"
          url: "http://localhost:8080/mcp"
        tools:
          allow:
            - "tavily_search"
            - "tavily_extract"
            - "tavily_crawl"
```

## Usage Examples

### Example 1: Research and Analysis

```typescript
// 1. Search for recent information
await callTool("tavily_search", {
  "query": "AI safety research 2024",
  "topic": "news",
  "days": 30,
  "include_answer": true,
  "max_results": 10,
});

// 2. Extract specific articles for detailed analysis
await callTool("tavily_extract", {
  "urls": [
    "https://ai-safety-journal.com/recent-research",
    "https://research-institute.edu/ai-safety-paper",
  ],
});
```

### Example 2: Competitive Intelligence

```typescript
// 1. Search competitor information
await callTool("tavily_search", {
  "query": "competitor product launches 2024",
  "search_depth": "advanced",
  "include_domains": ["techcrunch.com", "venturebeat.com"],
  "max_results": 15,
});

// 2. Crawl competitor documentation
await callTool("tavily_crawl", {
  "url": "https://competitor.com/docs",
  "max_depth": 2,
  "exclude_domains": ["competitor.com/marketing"],
});
```

### Example 3: Content Research

```typescript
// 1. Find authoritative sources
await callTool("tavily_search", {
  "query": "climate change scientific consensus",
  "include_domains": ["nature.com", "science.org", "ipcc.ch"],
  "include_answer": true,
  "include_raw_content": true,
});

// 2. Extract full research papers
await callTool("tavily_extract", {
  "urls": ["https://nature.com/articles/climate-study-2024"],
  "include_raw_content": true,
});
```

## Best Practices

1. **API Key Security**: Store Tavily API key in environment variables, never in code
2. **Rate Limiting**: Tavily has API limits - implement appropriate delays for bulk operations
3. **Query Optimization**: Use specific queries and domain filtering for better results
4. **Content Processing**: Enable `include_answer` for quick summaries, `include_raw_content` for
   detailed analysis
5. **Error Handling**: Always handle network errors and API failures gracefully
6. **Cost Management**: Monitor API usage and adjust max_results based on needs

## Advantages Over Traditional Web Scraping

- **AI-Enhanced Results**: Intelligent content filtering and summarization
- **No Browser Dependencies**: Direct API integration without browser automation overhead
- **Built-in Content Extraction**: Advanced text extraction and cleaning
- **Search Intelligence**: Context-aware search with relevance ranking
- **Rate Limit Handling**: Built-in request management and error handling
- **Multi-Format Support**: Handles various content types and formats

## Integration with Atlas Agents

Tavily tools work seamlessly with Atlas LLM agents:

```yaml
agents:
  research-agent:
    type: "llm"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        You are a research analyst. Use Tavily tools to:
        1. Search for recent information on your assigned topics
        2. Extract detailed content from authoritative sources
        3. Crawl relevant websites for comprehensive coverage
        4. Synthesize findings into actionable insights
      tools: ["atlas-platform"]
```

The Tavily integration provides powerful web research capabilities for Atlas workspaces, enabling
agents to access current web information with AI-enhanced processing and extraction.
