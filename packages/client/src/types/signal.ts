/**
 * Signal-related type definitions
 */

export interface SignalInfo {
  name: string;
  description?: string;
}

export interface SignalDetailedInfo {
  name: string;
  description?: string;
  provider: string;
  method?: string;
  path?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  config?: Record<string, unknown>;
  schema?: { type: string; properties?: Record<string, unknown>; required?: string[] };
  webhook_secret?: string;
  timeout_ms?: number;
  retry_config?: { max_retries?: number; retry_delay_ms?: number };
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
