import type { ITempestContext, ITempestContextManager } from "../types/core.ts";

export class ContextManager implements ITempestContextManager {
  private contexts: ITempestContext[] = [];

  add(context: ITempestContext): void {
    this.contexts.push(context);
  }

  remove(context: ITempestContext): void {
    const index = this.contexts.findIndex(
      (c) => c.source.id === context.source.id && c.source.type === context.source.type,
    );
    if (index !== -1) {
      this.contexts.splice(index, 1);
    }
  }

  search(query: string): ITempestContext[] {
    return this.contexts.filter(
      (context) =>
        context.detail.toLowerCase().includes(query.toLowerCase()) ||
        context.source.id.toLowerCase().includes(query.toLowerCase()) ||
        context.source.type.toLowerCase().includes(query.toLowerCase()),
    );
  }

  size(): number {
    return this.contexts.length;
  }

  getAll(): ITempestContext[] {
    return [...this.contexts];
  }
}
