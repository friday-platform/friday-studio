import type { 
  IAtlasScope, 
  IWorkspaceSupervisor, 
  ITempestContextManager, 
  ITempestMemoryManager, 
  ITempestMessageManager,
  IAtlasGate
} from "../types/core.ts";
import { ContextManager } from "./context.ts";
import { MemoryManager } from "./memory.ts";
import { MessageManager } from "./messages.ts";

export class AtlasScope implements IAtlasScope {
  public readonly id: string;
  public parentScopeId?: string;
  public supervisor?: IWorkspaceSupervisor;
  public context: ITempestContextManager;
  public memory: ITempestMemoryManager;
  public messages: ITempestMessageManager;
  public prompts: { system: string; user: string };
  public gates: IAtlasGate[] = [];

  constructor(
    parentScopeId?: string,
    supervisor?: IWorkspaceSupervisor
  ) {
    this.id = crypto.randomUUID();
    this.parentScopeId = parentScopeId;
    this.supervisor = supervisor;
    this.context = new ContextManager();
    this.memory = new MemoryManager();
    this.messages = new MessageManager();
    this.prompts = {
      system: "",
      user: ""
    };
  }

  newConversation(): ITempestMessageManager {
    this.messages = new MessageManager();
    return this.messages;
  }

  getConversation(): ITempestMessageManager {
    return this.messages;
  }

  archiveConversation(): void {
    // Store current conversation in memory before clearing
    this.memory.remember(`conversation_${Date.now()}`, this.messages.getHistory());
    this.messages = new MessageManager();
  }

  deleteConversation(): void {
    this.messages = new MessageManager();
  }
}