# Markdown Rendering Specification

## Overview

This document specifies how to transform Lezer markdown AST nodes into clean HTML output for the
Atlas web client message display.

## Supported Elements

### Block Elements

#### Paragraphs

- **AST Node**: `Paragraph`
- **HTML Output**: `<p>` tag
- **Special Cases**:
  - When parent is `ListItem`, do NOT wrap in `<p>` tags
  - Strip any surrounding whitespace

#### Unordered Lists

- **AST Node**: `BulletList`
- **HTML Output**: `<ul>` tag containing `<li>` elements
- **Children**: Process `ListItem` nodes

#### Ordered Lists

- **AST Node**: `OrderedList`
- **HTML Output**: `<ol>` tag containing `<li>` elements
- **Children**: Process `ListItem` nodes

#### List Items

- **AST Node**: `ListItem`
- **HTML Output**: `<li>` tag
- **Special Handling**:
  - Skip the `ListMark` child (it's just the bullet/number marker)
  - Process `Paragraph` children WITHOUT wrapping in `<p>` tags
  - Directly render the paragraph content inside the `<li>`

### Inline Elements

#### Bold Text

- **AST Node**: `StrongEmphasis`
- **HTML Output**: `<strong>` tag
- **Content Processing**: Strip the `**` or `__` markers from content

#### Italic Text

- **AST Node**: `Emphasis`
- **HTML Output**: `<em>` tag
- **Content Processing**: Strip the `*` or `_` markers from content

#### Strikethrough Text

- **AST Node**: `Strikethrough`
- **HTML Output**: `<del>` tag
- **Content Processing**: Strip the `~~` markers from content

#### Links

- **AST Node**: `Link`
- **HTML Output**: `<a href="...">` tag
- **Content Processing**: Extract URL and link text from markdown syntax

#### Inline Code

- **AST Node**: `InlineCode`
- **HTML Output**: `<code>` tag
- **Content Processing**: Strip the backtick markers

#### Code Blocks

- **AST Node**: `CodeBlock`
- **HTML Output**: `<pre><code>` tags
- **Content Processing**: Strip the triple backtick markers and language identifier

### Unsupported Elements (Transform to Alternatives)

#### Headers (H1-H6)

- **AST Nodes**: `ATXHeading1` through `ATXHeading6`
- **HTML Output**: `<p><strong>` tags
- **Transformation**: Convert all headers to paragraphs with bold text
- **Content Processing**: Strip the `#` markers

#### Horizontal Rules

- **AST Node**: `HorizontalRule`
- **HTML Output**: None (skip entirely)
- **Transformation**: Remove from output

#### Block Quotes

- **AST Node**: `BlockQuote`
- **HTML Output**: `<blockquote>` tag (if we decide to support)
- **Current Status**: Not mentioned in requirements, handle as needed

## Rendering Rules

### Node Processing Flow

1. **Document Node**: Start here, process all children
2. **Skip Marker Nodes**: Ignore `ListMark`, `HeaderMark`, `EmphasisMark` nodes
3. **Context-Aware Rendering**: Track parent type to handle special cases (e.g., Paragraph in
   ListItem)
4. **Content Extraction**: For leaf nodes, extract clean text without markdown syntax

### Text Content Extraction

For nodes that contain markdown syntax in their content, clean the text:

```javascript
// Example for StrongEmphasis
content.replace(/^(\*\*|__)/, '').replace(/(\*\*|__)$/, '');

// Example for Headers
content.replace(/^#+\s*/, '');

// Example for Links
content.match(/\[([^\]]+)\]\(([^)]+)\)/); // Extract text and URL
```

### HTML Structure Requirements

1. **Valid HTML5**: Output must be valid HTML5
2. **No Nested Paragraphs**: Never put `<p>` inside `<li>` or other `<p>` tags
3. **Clean Output**: No markdown syntax should appear in final rendered output
4. **Line Breaks**: Preserve line breaks where semantically meaningful

## Example Transformations

### Simple Paragraph

```markdown
This is a paragraph.
```

```html
<p>This is a paragraph.</p>
```

### List with Inline Formatting

```markdown
- **Bold item** with text
- Item with _italic_ text
```

```html
<ul>
	<li><strong>Bold item</strong> with text</li>
	<li>Item with <em>italic</em> text</li>
</ul>
```

### Header to Bold Paragraph

```markdown
## This is a header
```

```html
<p><strong>This is a header</strong></p>
```

### Mixed Content

```markdown
Here is a paragraph with **bold** and _italic_ text.

1. First item
2. Second item with [a link](https://example.com)
```

```html
<p>Here is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
<ol>
	<li>First item</li>
	<li>Second item with <a href="https://example.com">a link</a></li>
</ol>
```

## Implementation Notes

1. Use a recursive renderer that processes nodes depth-first
2. Maintain parent context to handle special cases
3. Keep a mapping of node types to their HTML equivalents
4. Clean text content at the leaf node level
5. Skip unwanted nodes entirely (don't process their children)

## Testing Strategy

### Unit Tests

1. **AST Parser Tests**
   - Verify Lezer correctly parses all supported markdown syntax
   - Test edge cases like nested emphasis, mixed lists, etc.
   - Ensure partial markdown (incomplete syntax) doesn't break parser

2. **HTML Renderer Tests**
   - Test each node type transformation individually
   - Verify correct HTML structure (no nested `<p>` in `<li>`)
   - Test marker stripping (removing `**`, `#`, etc.)
   - Verify skipped nodes (HR, markers) don't appear in output

3. **Integration Tests**
   - Test complex markdown with multiple element types
   - Verify streaming/partial markdown renders correctly
   - Test malformed markdown handling

### Test Cases

#### Basic Elements

```javascript
// Test: Simple paragraph
input: 'Hello world';
expected: '<p>Hello world</p>';

// Test: Bold text
input: '**bold text**';
expected: '<p><strong>bold text</strong></p>';

// Test: Italic text
input: '*italic text*';
expected: '<p><em>italic text</em></p>';

// Test: Strikethrough
input: '~~struck text~~';
expected: '<p><del>struck text</del></p>';

// Test: Link
input: '[link text](https://example.com)';
expected: '<p><a href="https://example.com">link text</a></p>';

// Test: Inline code
input: '`code`';
expected: '<p><code>code</code></p>';
```

#### Lists

```javascript
// Test: Unordered list
input: '- Item 1\n- Item 2';
expected: '<ul><li>Item 1</li><li>Item 2</li></ul>';

// Test: Ordered list
input: '1. First\n2. Second';
expected: '<ol><li>First</li><li>Second</li></ol>';

// Test: List with inline formatting
input: '- **Bold** item\n- *Italic* item';
expected: '<ul><li><strong>Bold</strong> item</li><li><em>Italic</em> item</li></ul>';
```

#### Headers to Paragraphs

```javascript
// Test: H1 to bold paragraph
input: '# Header 1';
expected: '<p><strong>Header 1</strong></p>';

// Test: H2 to bold paragraph
input: '## Header 2';
expected: '<p><strong>Header 2</strong></p>';

// Test: Header with inline formatting
input: '## Header with *italic*';
expected: '<p><strong>Header with <em>italic</em></strong></p>';
```

#### Edge Cases

```javascript
// Test: Horizontal rule removal
input: 'Text\n\n---\n\nMore text';
expected: '<p>Text</p><p>More text</p>';

// Test: Empty list item
input: '- \n- Item';
expected: '<ul><li></li><li>Item</li></ul>';

// Test: Nested emphasis
input: '**bold with *italic* inside**';
expected: '<p><strong>bold with <em>italic</em> inside</strong></p>';

// Test: Incomplete markdown (streaming)
input: 'This is **bold';
expected: '<p>This is **bold</p>'; // Should handle gracefully

// Test: Mixed line breaks
input: 'Line 1\n\nLine 2';
expected: '<p>Line 1</p><p>Line 2</p>';
```

### Visual Testing

1. **Render Comparison**
   - Compare output with expected browser rendering
   - Test with real message content from Atlas
   - Verify styling consistency

2. **Streaming Behavior**
   - Test partial markdown rendering during streaming
   - Ensure no flickering or layout shifts
   - Verify incremental updates work correctly

### Performance Testing

1. **Large Documents**
   - Test with messages containing 1000+ lines
   - Measure parse and render time
   - Ensure no UI freezing

2. **Rapid Updates**
   - Test with fast streaming updates
   - Verify DOM updates are efficient
   - Check for memory leaks with long conversations
