import type {
  IAtlasGate,
  IAtlasScope,
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
}

export class AtlasScope implements IAtlasScope {
  public readonly id: string;
  public readonly workspaceId?: string;
  public parentScopeId?: string;
  public supervisor?: IWorkspaceSupervisor;
  public context: ITempestContextManager;
  public messages: ITempestMessageManager;
  public prompts: { system: string; user: string };
  public gates: IAtlasGate[] = [];

  constructor(parentScopeId?: string, supervisor?: IWorkspaceSupervisor);
  constructor(options?: AtlasScopeOptions);
  constructor(
    parentScopeIdOrOptions?: string | AtlasScopeOptions,
    supervisor?: IWorkspaceSupervisor,
  ) {
    // Handle overloaded constructor
    let actualId: string | undefined;
    let actualWorkspaceId: string | undefined;
    let actualParentScopeId: string | undefined;
    let actualSupervisor: IWorkspaceSupervisor | undefined;

    if (typeof parentScopeIdOrOptions === "object" && parentScopeIdOrOptions !== null) {
      // Options object provided
      actualId = parentScopeIdOrOptions.id;
      actualWorkspaceId = parentScopeIdOrOptions.workspaceId;
      actualParentScopeId = parentScopeIdOrOptions.parentScopeId;
      actualSupervisor = parentScopeIdOrOptions.supervisor;
    } else if (typeof parentScopeIdOrOptions === "string") {
      // Legacy parameters provided
      actualParentScopeId = parentScopeIdOrOptions;
      actualSupervisor = supervisor;
    } else {
      // No parameters provided
      actualParentScopeId = undefined;
      actualSupervisor = undefined;
    }

    this.id = actualId || crypto.randomUUID();
    this.workspaceId = actualWorkspaceId;
    this.parentScopeId = actualParentScopeId;
    this.supervisor = actualSupervisor;
    this.context = new ContextManager();
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
    // Reset messages (memory storage removed - TEM-3631)
    this.messages = new MessageManager();
  }

  deleteConversation(): void {
    this.messages = new MessageManager();
  }
}
