# Web Automation Tools

This module extends the basic `atlas_fetch` tool with session-based web automation capabilities,
including automatic cookie consent handling.

## Architecture

**Session-Based Design:**

- Persistent browser contexts maintain state across operations
- Sessions auto-expire after 30 minutes of inactivity
- Each session runs in an isolated Playwright browser instance
- Supports multiple concurrent sessions

## Available Tools

### Session Management

#### `web_session_create`

Creates a persistent browser session for multi-step automation.

```typescript
// Create a new session
{
  "sessionId": "my-session",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "viewport": { "width": 1280, "height": 720 },
  "locale": "en-US"
}
```

#### `web_session_navigate`

Navigates to URLs within a session, maintaining cookies and state.

```typescript
{
  "sessionId": "my-session",
  "url": "https://example.com",
  "waitUntil": "networkidle"
}
```

#### `web_session_extract`

Extracts content from the current page in various formats.

```typescript
{
  "sessionId": "my-session",
  "format": "markdown",
  "selector": "article" // Optional: extract specific elements
}
```

#### `web_session_click`

Clicks elements by selector, text, or accessibility attributes.

```typescript
{
  "sessionId": "my-session",
  "text": "Accept All Cookies",
  "timeout": 10
}
```

#### `web_session_close`

Closes a session and releases resources.

```typescript
{
  "sessionId": "my-session"
}
```

#### `web_session_list`

Lists all active sessions with their status.

### Cookie Consent Handling

#### `web_session_handle_consent`

Automatically detects and handles cookie consent banners.

```typescript
{
  "sessionId": "my-session",
  "action": "accept", // or "reject" or "detect"
  "timeout": 10
}
```

**Supported Consent Systems:**

- OneTrust
- CookieBot
- Quantcast Choice
- TrustArc
- Generic patterns (Accept/Reject buttons)

#### `web_session_wait_for_element`

Waits for elements to appear, disappear, or change visibility.

```typescript
{
  "sessionId": "my-session",
  "selector": "#consent-banner",
  "state": "hidden"
}
```

## Usage Examples

### Example 1: Handle Cookie Consent and Extract Data

```typescript
// 1. Create session
await callTool("web_session_create", {
  "sessionId": "news-scraper",
  "viewport": { "width": 1920, "height": 1080 },
});

// 2. Navigate to site
await callTool("web_session_navigate", {
  "sessionId": "news-scraper",
  "url": "https://example-news-site.com",
});

// 3. Handle cookie consent
await callTool("web_session_handle_consent", {
  "sessionId": "news-scraper",
  "action": "accept",
});

// 4. Extract article content
await callTool("web_session_extract", {
  "sessionId": "news-scraper",
  "format": "markdown",
  "selector": "article",
});

// 5. Clean up
await callTool("web_session_close", {
  "sessionId": "news-scraper",
});
```

### Example 2: Multi-Step Form Interaction

```typescript
// 1. Create session
await callTool("web_session_create", {
  "sessionId": "form-filler",
});

// 2. Navigate to form
await callTool("web_session_navigate", {
  "sessionId": "form-filler",
  "url": "https://example.com/contact",
});

// 3. Handle consent first
await callTool("web_session_handle_consent", {
  "sessionId": "form-filler",
  "action": "accept",
});

// 4. Click through form steps
await callTool("web_session_click", {
  "sessionId": "form-filler",
  "selector": "#next-step-button",
});

// 5. Wait for new content to load
await callTool("web_session_wait_for_element", {
  "sessionId": "form-filler",
  "selector": "#step-2-form",
  "state": "visible",
});

// 6. Extract final result
await callTool("web_session_extract", {
  "sessionId": "form-filler",
  "format": "text",
});
```

### Example 3: Custom Consent Handling

```typescript
// For sites with non-standard consent implementations
await callTool("web_session_handle_consent", {
  "sessionId": "my-session",
  "action": "accept",
  "customSelector": ".custom-accept-btn",
  "waitAfterClick": 3,
});
```

## Best Practices

1. **Session Lifecycle**: Always close sessions when done to free resources
2. **Error Handling**: Sessions auto-expire after 30 minutes of inactivity
3. **Consent First**: Handle cookie consent before interacting with content
4. **Wait Strategies**: Use appropriate wait conditions for dynamic content
5. **Resource Management**: Monitor active sessions with `web_session_list`

## Advantages Over Single-Request Tools

- **Persistent State**: Cookies and session data maintained across operations
- **Complex Workflows**: Multi-step interactions with forms and navigation
- **Consent Handling**: Automatic detection and handling of privacy banners
- **Dynamic Content**: Wait for JavaScript-rendered content to load
- **Resource Efficiency**: Reuse browser instances for multiple operations

## Integration

The session-based tools work alongside the original `atlas_fetch` tool:

- Use `atlas_fetch` for simple, one-off content retrieval
- Use session tools for complex, multi-step web automation
- Both tools support the same content formats (text, markdown, HTML)
