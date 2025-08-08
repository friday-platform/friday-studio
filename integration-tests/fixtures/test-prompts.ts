/**
 * Test Prompts for Agent MCP Server Access Testing
 * 
 * Collection of prompts used for testing different scenarios
 */

export const TestPrompts = {
  // Basic tool execution
  echo: {
    simple: "echo Hello World",
    withSpaces: "echo This is a test with spaces",
    empty: "echo ",
    unicode: "echo Hello 世界 🌍",
  },

  reverse: {
    simple: "reverse hello",
    sentence: "reverse The quick brown fox",
    palindrome: "reverse racecar",
  },

  uppercase: {
    simple: "uppercase hello",
    mixed: "uppercase HeLLo WoRLd",
    withNumbers: "uppercase test123",
  },

  wordCount: {
    simple: "word_count hello world",
    empty: "word_count ",
    multiSpace: "word_count   multiple   spaces   between   words",
    sentence: "word_count The quick brown fox jumps over the lazy dog",
  },

  // Math operations
  math: {
    calculate: {
      addition: "calculate 2 + 2",
      multiplication: "calculate 10 * 5",
      complex: "calculate (10 + 5) * 2 - 8",
    },
    random: {
      default: "random_number",
      range: "random_number 1 100",
    },
    statistics: {
      simple: "statistics [1, 2, 3, 4, 5]",
      large: "statistics [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]",
    },
  },

  // API operations
  api: {
    fetchUser: {
      valid: "fetch_user user-1",
      invalid: "fetch_user nonexistent",
    },
    createPost: {
      simple: "create_post user-1 'Test Title' 'Test content'",
    },
    listItems: {
      all: "list_items",
      filtered: "list_items maxPrice=15",
    },
  },

  // File operations
  file: {
    read: "file_read /test/file.txt",
    write: "file_write /test/output.txt 'Test content'",
    list: "list_directory /test",
  },

  // Complex scenarios
  complex: {
    multiTool: "echo hello then reverse it and make it uppercase",
    coordination: "fetch user-1 and uppercase their name",
    filtering: "try to write a file when write is denied",
  },

  // Error scenarios
  errors: {
    unknownTool: "use_unknown_tool",
    invalidArgs: "echo",
    serverNotFound: "use tool from nonexistent_server",
  },
};

/**
 * Generate dynamic test prompts
 */
export class PromptGenerator {
  static echoWithLength(length: number): string {
    const text = "a".repeat(length);
    return `echo ${text}`;
  }

  static calculateExpression(a: number, b: number, op: string): string {
    return `calculate ${a} ${op} ${b}`;
  }

  static wordCountWithWords(count: number): string {
    const words = Array.from({ length: count }, (_, i) => `word${i + 1}`).join(" ");
    return `word_count ${words}`;
  }

  static fetchUserById(id: string): string {
    return `fetch_user ${id}`;
  }

  static createPostWithData(userId: string, title: string, content: string): string {
    return `create_post ${userId} '${title}' '${content}'`;
  }

  static randomNumberInRange(min: number, max: number): string {
    return `random_number ${min} ${max}`;
  }

  static statisticsWithArray(numbers: number[]): string {
    return `statistics [${numbers.join(", ")}]`;
  }
}