/**
 * Signal-related type definitions
 */

export interface SignalInfo {
  name: string;
  description?: string;
}

export interface SignalTriggerResponse {
  message: string;
  status: string;
  workspaceId: string;
  signalId: string;
}

export interface SignalResponse {
  success: boolean;
  message?: string;
  sessionId?: string;
  error?: string;
}
