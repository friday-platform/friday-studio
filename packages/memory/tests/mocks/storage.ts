// /**
//  * Mock storage implementations for memory integration tests
//  * Simple in-memory implementations that don't require complex setup
//  */

/**
 * Mock LLM provider for testing (prevents actual LLM calls)
 */
export class MockLLMProvider {
  private responses = new Map<string, string>();

  setResponse(prompt: string, response: string): void {
    this.responses.set(prompt, response);
  }

  async generate(prompt: string): Promise<string> {
    // Return predefined response or empty facts array
    return this.responses.get(prompt) || "[]";
  }

  clear(): void {
    this.responses.clear();
  }
}

/**
 * Simple mock AtlasScope for testing
 */
export class MockAtlasScope {
  id: string;

  constructor(id?: string) {
    this.id = id || crypto.randomUUID();
  }

  // Mock methods that tests might expect
  newConversation(): unknown {
    return {};
  }

  getConversation(): unknown {
    return {};
  }

  archiveConversation(): void {}
  deleteConversation(): void {}
}
