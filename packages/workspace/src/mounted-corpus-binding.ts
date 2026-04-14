import type { NarrativeEntry } from "@atlas/agent-sdk";
import { MountReadonlyError } from "./mount-errors.ts";

export type MountMode = "ro" | "rw";
export type MountScope = "workspace" | "job" | "agent";

export interface MountFilter {
  since?: string;
  limit?: number;
}

export class MountedCorpusBinding {
  readonly name: string;
  readonly source: string;
  readonly mode: MountMode;
  readonly scope: MountScope;
  readonly scopeTarget?: string;

  private _read: (filter?: MountFilter) => Promise<NarrativeEntry[]>;
  private _append: (entry: NarrativeEntry) => Promise<NarrativeEntry>;

  constructor(opts: {
    name: string;
    source: string;
    mode: MountMode;
    scope: MountScope;
    scopeTarget?: string;
    read: (filter?: MountFilter) => Promise<NarrativeEntry[]>;
    append: (entry: NarrativeEntry) => Promise<NarrativeEntry>;
  }) {
    this.name = opts.name;
    this.source = opts.source;
    this.mode = opts.mode;
    this.scope = opts.scope;
    this.scopeTarget = opts.scopeTarget;
    this._read = opts.read;
    this._append = opts.append;
  }

  read(filter?: MountFilter): Promise<NarrativeEntry[]> {
    return this._read(filter);
  }

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    if (this.mode === "ro") {
      throw new MountReadonlyError(this.name);
    }
    return this._append(entry);
  }
}
