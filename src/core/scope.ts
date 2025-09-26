import { CoALAMemoryManager } from "@atlas/memory";
import type {
  IAtlasGate,
  IAtlasScope,
  ICoALAMemoryStorageAdapter,
  ITempestContextManager,
  ITempestMessageManager,
  IWorkspaceSupervisor,
} from "../types/core.ts";
import { ContextManager } from "./context.ts";
import { MessageManager } from "./messages.ts";

export interface AtlasScopeOptions {
  id?: string;
  workspaceId?: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  storageAdapter?: ICoALAMemoryStorageAdapter;
  enableCognitiveLoop?: boolean;
}

export class AtlasScope implements IAtlasScope {
  public readonly id: string;
  public readonly workspaceId?: string;
  public parentScopeId?: string;
  public supervisor?: IWorkspaceSupervisor;
  public context: ITempestContextManager;
  public memory: CoALAMemoryManager;
  public messages: ITempestMessageManager;
  public prompts: { system: string; user: string };
  public gates: IAtlasGate[] = [];

  constructor(
    parentScopeId?: string,
    supervisor?: IWorkspaceSupervisor,
    storageAdapter?: ICoALAMemoryStorageAdapter,
    enableCognitiveLoop?: boolean,
  );
  constructor(options?: AtlasScopeOptions);
  constructor(
    parentScopeIdOrOptions?: string | AtlasScopeOptions,
    supervisor?: IWorkspaceSupervisor,
    storageAdapter?: ICoALAMemoryStorageAdapter,
    enableCognitiveLoop?: boolean,
  ) {
    // Handle overloaded constructor
    let actualId: string | undefined;
    let actualWorkspaceId: string | undefined;
    let actualParentScopeId: string | undefined;
    let actualSupervisor: IWorkspaceSupervisor | undefined;
    let actualStorageAdapter: ICoALAMemoryStorageAdapter | undefined;
    let actualEnableCognitiveLoop: boolean = true;

    if (typeof parentScopeIdOrOptions === "object" && parentScopeIdOrOptions !== null) {
      // Options object provided
      actualId = parentScopeIdOrOptions.id;
      actualWorkspaceId = parentScopeIdOrOptions.workspaceId;
      actualParentScopeId = parentScopeIdOrOptions.parentScopeId;
      actualSupervisor = parentScopeIdOrOptions.supervisor;
      actualStorageAdapter = parentScopeIdOrOptions.storageAdapter;
      actualEnableCognitiveLoop = parentScopeIdOrOptions.enableCognitiveLoop ?? true;
    } else if (typeof parentScopeIdOrOptions === "string") {
      // Legacy parameters provided
      actualParentScopeId = parentScopeIdOrOptions;
      actualSupervisor = supervisor;
      actualStorageAdapter = storageAdapter;
      actualEnableCognitiveLoop = enableCognitiveLoop ?? true;
    } else {
      // No parameters provided
      actualParentScopeId = undefined;
      actualSupervisor = undefined;
      actualStorageAdapter = undefined;
      actualEnableCognitiveLoop = true;
    }

    this.id = actualId || crypto.randomUUID();
    this.workspaceId = actualWorkspaceId;
    this.parentScopeId = actualParentScopeId;
    this.supervisor = actualSupervisor;
    this.context = new ContextManager();
    this.memory = new CoALAMemoryManager(this, actualStorageAdapter, actualEnableCognitiveLoop);
    this.messages = new MessageManager();
    this.prompts = { system: "", user: "" };
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
    const coalaMemory = this.memory;
    coalaMemory.rememberWithMetadata(
      `conversation_${Date.now()}`,
      this.messages
        .getHistory()
        .map((m) => m.message)
        .join("\n"),
      {
        memoryType: "episodic",
        tags: ["conversation", "archived", "historical"],
        relevanceScore: 0.5,
        confidence: 1.0,
        decayRate: 0.05, // Conversations decay slowly
      },
    );
    this.messages = new MessageManager();
  }

  deleteConversation(): void {
    this.messages = new MessageManager();
  }
}
