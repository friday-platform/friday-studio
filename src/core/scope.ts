import type {
  IAtlasGate,
  IAtlasScope,
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessageManager,
  IWorkspaceSupervisor,
} from "../types/core.ts";
import { ContextManager } from "./context.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "./memory/coala-memory.ts";
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
    supervisor?: IWorkspaceSupervisor,
  ) {
    this.id = crypto.randomUUID();
    this.parentScopeId = parentScopeId;
    this.supervisor = supervisor;
    this.context = new ContextManager();
    this.memory = new CoALAMemoryManager(this);
    this.messages = new MessageManager();
    this.prompts = {
      system: "",
      user: "",
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
    // Store current conversation in CoALA memory with appropriate metadata
    const coalaMemory = this.memory as CoALAMemoryManager;
    coalaMemory.rememberWithMetadata(
      `conversation_${Date.now()}`,
      this.messages.getHistory(),
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ['conversation', 'archived', 'historical'],
        relevanceScore: 0.5,
        confidence: 1.0,
        decayRate: 0.05 // Conversations decay slowly
      }
    );
    this.messages = new MessageManager();
  }

  deleteConversation(): void {
    this.messages = new MessageManager();
  }
}
