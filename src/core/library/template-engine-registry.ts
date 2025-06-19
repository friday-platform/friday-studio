import {
  ITemplateEngine,
  TemplateConfig,
  TemplateEngineRegistry as ITemplateEngineRegistry,
} from "./types.ts";

/**
 * Registry for template engines supporting pluggable template processing
 */
export class TemplateEngineRegistry implements ITemplateEngineRegistry {
  private engines = new Map<string, ITemplateEngine>();

  register(engine: ITemplateEngine): void {
    this.engines.set(engine.type, engine);
  }

  getEngine(type: string): ITemplateEngine | undefined {
    return this.engines.get(type);
  }

  findEngine(template: TemplateConfig): ITemplateEngine | undefined {
    // First try exact engine match
    const exactEngine = this.engines.get(template.engine);
    if (exactEngine && exactEngine.canHandle(template)) {
      return exactEngine;
    }

    // Fallback: find any engine that can handle this template
    for (const engine of this.engines.values()) {
      if (engine.canHandle(template)) {
        return engine;
      }
    }

    return undefined;
  }

  listEngines(): ITemplateEngine[] {
    return Array.from(this.engines.values());
  }

  getAvailableEngineTypes(): string[] {
    return Array.from(this.engines.keys());
  }
}

/**
 * Create default registry with built-in engines
 */
export async function createDefaultRegistry(): Promise<TemplateEngineRegistry> {
  const registry = new TemplateEngineRegistry();

  // Import and register built-in engines
  const { PromptTemplateEngine } = await import("./engines/prompt-template-engine.ts");
  registry.register(new PromptTemplateEngine());

  // Future engines can be added here:
  // const { HandlebarsTemplateEngine } = await import("./engines/handlebars-template-engine.ts");
  // registry.register(new HandlebarsTemplateEngine());

  return registry;
}
