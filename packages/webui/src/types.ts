export const APP_NAME = 'SnowLuma';
export const APP_VERSION = '0.1.0';

export interface QQInfo {
  uin: string;
  nickname: string;
}

export interface HookProcessInfo {
  pid: number;
  name: string;
  path: string;
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: 'available' | 'loading' | 'connecting' | 'loaded' | 'online' | 'error' | 'disconnected';
  error: string;
  method: string;
}

export type MessageFormat = 'array' | 'string';
export type WsRole = 'Api' | 'Event' | 'Universal';

interface NetworkBase {
  name: string;
  enabled?: boolean;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

export interface HttpServerNetwork extends NetworkBase {
  host?: string;
  port: number;
  path?: string;
}

export interface HttpClientNetwork extends NetworkBase {
  url: string;
  timeoutMs?: number;
}

export interface WsServerNetwork extends NetworkBase {
  host?: string;
  port: number;
  path?: string;
  role?: WsRole;
}

export interface WsClientNetwork extends NetworkBase {
  url: string;
  role?: WsRole;
  reconnectIntervalMs?: number;
}

export interface OneBotNetworks {
  httpServers: HttpServerNetwork[];
  httpClients: HttpClientNetwork[];
  wsServers: WsServerNetwork[];
  wsClients: WsClientNetwork[];
}

export interface OneBotConfig {
  networks: OneBotNetworks;
  musicSignUrl?: string;
}

export type NetworkKind = keyof OneBotNetworks;

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  uptime: number;
  processUptime: number;
  nodeVersion: string;
  cpu: {
    model: string;
    cores: number;
    speedMHz: number;
    loadAvg: number[];
    perCore: number[];
    average: number;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usagePercent: number;
  };
  runtime: {
    pid: number;
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
}

export interface LogEntry {
  id: number;
  time: string;
  level: 'debug' | 'info' | 'success' | 'warn' | 'error';
  scope: string;
  message: string;
  line: string;
}
