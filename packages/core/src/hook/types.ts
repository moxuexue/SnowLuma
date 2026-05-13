import type { HookProcessBaseInfo } from './injector';

/**
 * Lifecycle status of a single per-PID HookSession.
 *
 * Transitions live inside HookSession; this union only enumerates the
 * states visible to API callers (WebUI, manager.listProcesses()).
 */
export type HookProcessStatus =
  | 'available'
  | 'loading'
  | 'connecting'
  | 'loaded'
  | 'online'
  | 'error'
  | 'disconnected';

/** Public-facing snapshot of a per-PID HookSession. */
export interface HookProcessInfo extends HookProcessBaseInfo {
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: HookProcessStatus;
  error: string;
  method: string;
}
