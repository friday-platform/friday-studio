/**
 * In-memory todo storage for conversation sessions.
 *
 * Used by conversation agents to track tasks during chat sessions:
 * - conversation.agent.ts: Provides todo tools to the LLM for task tracking
 * - todo-tools.ts: Read/write tools that call daemon API endpoints which use this storage
 *
 * Each stream (conversation session) maintains its own todo list.
 */

import type { TodoItem } from "@atlas/config";

class TodoStorage {
  private todos = new Map<string, TodoItem[]>();

  get(streamId: string): TodoItem[] {
    return this.todos.get(streamId) || [];
  }

  set(streamId: string, todos: TodoItem[]): void {
    this.todos.set(streamId, todos);
  }

  delete(streamId: string): boolean {
    return this.todos.delete(streamId);
  }

  streams(): string[] {
    return Array.from(this.todos.keys());
  }
}

export const todoStorage = new TodoStorage();
