/**
 * Federation Manager for Atlas
 * Handles cross-workspace access control and scope resolution
 */

import type { AtlasConfig, FederationConfig, FederationSharing } from "@atlas/types";

export class FederationAccessError extends Error {
  constructor(
    message: string,
    public sourceWorkspace: string,
    public targetWorkspace: string,
    public capability: string,
  ) {
    super(message);
    this.name = "FederationAccessError";
  }
}

export interface AccessCheckResult {
  allowed: boolean;
  reason: string;
  grantedScopes: string[];
}

export interface ScopeResolutionResult {
  scopes: string[];
  source: "predefined" | "inline" | "grants";
}

export class FederationManager {
  private federationConfig: FederationConfig | undefined;
  private scopeCache = new Map<string, string[]>();

  constructor(atlasConfig: AtlasConfig) {
    this.federationConfig = atlasConfig.federation;
  }

  /**
   * Check if a source workspace can access a capability in a target workspace
   */
  checkAccess(
    sourceWorkspace: string,
    targetWorkspace: string,
    capability: string,
  ): AccessCheckResult {
    if (!this.federationConfig?.sharing) {
      return {
        allowed: false,
        reason: "No federation configuration found",
        grantedScopes: [],
      };
    }

    const sharing = this.federationConfig.sharing[sourceWorkspace];
    if (!sharing) {
      return {
        allowed: false,
        reason: `Source workspace '${sourceWorkspace}' has no sharing configuration`,
        grantedScopes: [],
      };
    }

    // Check if target workspace is in the shared workspaces list
    if (!this.isWorkspaceShared(sharing, targetWorkspace)) {
      return {
        allowed: false,
        reason:
          `Target workspace '${targetWorkspace}' is not shared with source workspace '${sourceWorkspace}'`,
        grantedScopes: [],
      };
    }

    // Get applicable scopes for this target workspace
    const scopes = this.getApplicableScopes(sharing, targetWorkspace);

    // Check if the capability is allowed by the scopes
    const allowed = this.isScopeAllowed(scopes, capability);

    return {
      allowed,
      reason: allowed
        ? `Access granted via scopes: ${scopes.join(", ")}`
        : `Capability '${capability}' not allowed by scopes: ${scopes.join(", ")}`,
      grantedScopes: scopes,
    };
  }

  /**
   * Validate access or throw error
   */
  validateAccess(
    sourceWorkspace: string,
    targetWorkspace: string,
    capability: string,
  ): void {
    const result = this.checkAccess(sourceWorkspace, targetWorkspace, capability);
    if (!result.allowed) {
      throw new FederationAccessError(
        result.reason,
        sourceWorkspace,
        targetWorkspace,
        capability,
      );
    }
  }

  /**
   * Get all workspaces that a source workspace can access
   */
  getAccessibleWorkspaces(sourceWorkspace: string): string[] {
    if (!this.federationConfig?.sharing) {
      return [];
    }

    const sharing = this.federationConfig.sharing[sourceWorkspace];
    if (!sharing) {
      return [];
    }

    const workspaces: string[] = [];

    // Add simple workspaces list
    if (sharing.workspaces) {
      if (typeof sharing.workspaces === "string") {
        workspaces.push(sharing.workspaces);
      } else {
        workspaces.push(...sharing.workspaces);
      }
    }

    // Add workspaces from grants
    if (sharing.grants) {
      for (const grant of sharing.grants) {
        if (!workspaces.includes(grant.workspace)) {
          workspaces.push(grant.workspace);
        }
      }
    }

    return workspaces;
  }

  /**
   * Get all capabilities a source workspace has on a target workspace
   */
  getGrantedCapabilities(
    sourceWorkspace: string,
    targetWorkspace: string,
  ): string[] {
    if (!this.federationConfig?.sharing) {
      return [];
    }

    const sharing = this.federationConfig.sharing[sourceWorkspace];
    if (!sharing) {
      return [];
    }

    if (!this.isWorkspaceShared(sharing, targetWorkspace)) {
      return [];
    }

    return this.getApplicableScopes(sharing, targetWorkspace);
  }

  /**
   * Resolve scopes (expand scope_sets and handle wildcards)
   */
  resolveScopes(scopes: string | string[]): ScopeResolutionResult {
    const scopeArray = typeof scopes === "string" ? [scopes] : scopes;
    const resolved: string[] = [];

    for (const scope of scopeArray) {
      if (this.federationConfig?.scope_sets?.[scope]) {
        // Predefined scope set
        resolved.push(...this.federationConfig.scope_sets[scope]);
      } else {
        // Direct scope
        resolved.push(scope);
      }
    }

    return {
      scopes: [...new Set(resolved)], // Remove duplicates
      source: scopeArray.some((s) => this.federationConfig?.scope_sets?.[s])
        ? "predefined"
        : "inline",
    };
  }

  /**
   * Check if a specific scope allows a capability
   */
  isScopeAllowed(scopes: string[], capability: string): boolean {
    return scopes.some((scope) => this.matchesScope(scope, capability));
  }

  /**
   * Get federation statistics
   */
  getStats(): {
    totalSharingConfigs: number;
    totalScopeSets: number;
    totalWorkspaceConnections: number;
  } {
    const sharing = this.federationConfig?.sharing || {};
    const scopeSets = this.federationConfig?.scope_sets || {};

    let totalConnections = 0;
    for (const config of Object.values(sharing)) {
      totalConnections += this.getAccessibleWorkspacesFromSharing(config).length;
    }

    return {
      totalSharingConfigs: Object.keys(sharing).length,
      totalScopeSets: Object.keys(scopeSets).length,
      totalWorkspaceConnections: totalConnections,
    };
  }

  /**
   * Validate federation configuration
   */
  static validateConfig(federationConfig: FederationConfig): string[] {
    const errors: string[] = [];

    if (!federationConfig.sharing && !federationConfig.scope_sets) {
      return []; // Empty config is valid
    }

    // Validate scope_sets references
    if (federationConfig.sharing) {
      for (const [workspace, sharing] of Object.entries(federationConfig.sharing)) {
        // Check workspace-level scopes
        if (typeof sharing.scopes === "string") {
          if (!federationConfig.scope_sets?.[sharing.scopes]) {
            errors.push(
              `Workspace '${workspace}' references undefined scope_set '${sharing.scopes}'`,
            );
          }
        }

        // Check grant-level scopes
        if (sharing.grants) {
          for (const grant of sharing.grants) {
            if (typeof grant.scopes === "string") {
              if (!federationConfig.scope_sets?.[grant.scopes]) {
                errors.push(
                  `Grant for workspace '${grant.workspace}' references undefined scope_set '${grant.scopes}'`,
                );
              }
            }
          }
        }
      }
    }

    return errors;
  }

  // Private helper methods

  private isWorkspaceShared(sharing: FederationSharing, targetWorkspace: string): boolean {
    // Check simple workspaces list
    if (sharing.workspaces) {
      if (typeof sharing.workspaces === "string") {
        return sharing.workspaces === targetWorkspace;
      } else {
        return sharing.workspaces.includes(targetWorkspace);
      }
    }

    // Check grants
    if (sharing.grants) {
      return sharing.grants.some((grant) => grant.workspace === targetWorkspace);
    }

    return false;
  }

  private getApplicableScopes(sharing: FederationSharing, targetWorkspace: string): string[] {
    // Check for workspace-specific grant first
    if (sharing.grants) {
      const grant = sharing.grants.find((g) => g.workspace === targetWorkspace);
      if (grant) {
        return this.resolveScopes(grant.scopes).scopes;
      }
    }

    // Fall back to workspace-level scopes
    if (sharing.scopes) {
      return this.resolveScopes(sharing.scopes).scopes;
    }

    return [];
  }

  private getAccessibleWorkspacesFromSharing(sharing: FederationSharing): string[] {
    const workspaces: string[] = [];

    if (sharing.workspaces) {
      if (typeof sharing.workspaces === "string") {
        workspaces.push(sharing.workspaces);
      } else {
        workspaces.push(...sharing.workspaces);
      }
    }

    if (sharing.grants) {
      for (const grant of sharing.grants) {
        if (!workspaces.includes(grant.workspace)) {
          workspaces.push(grant.workspace);
        }
      }
    }

    return workspaces;
  }

  private matchesScope(scope: string, capability: string): boolean {
    // Exact match
    if (scope === capability) {
      return true;
    }

    // Wildcard match (e.g., "jobs.*" matches "jobs.trigger")
    if (scope.endsWith(".*")) {
      const prefix = scope.slice(0, -2);
      return capability.startsWith(prefix + ".");
    }

    // Root wildcard (e.g., "*" matches everything)
    if (scope === "*") {
      return true;
    }

    return false;
  }
}
