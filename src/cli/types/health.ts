/**
 * Health check response from workspace server
 */
export interface WorkspaceHealthData {
  status: string;
  workspace: string;
  sessions: number;
  uptime: number;
  detached: boolean;
  memory?: { heapUsed: number; heapTotal: number };
}
