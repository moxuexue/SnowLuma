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
  status: 'available' | 'loading' | 'loaded' | 'online' | 'error' | 'disconnected';
  error: string;
  method: string;
}

export interface HttpServerEndpoint {
  name?: string;
  host?: string;
  port?: number;
  path?: string;
  accessToken?: string;
}

export interface WsServerEndpoint {
  name?: string;
  host?: string;
  port?: number;
  path?: string;
  role?: string;
  accessToken?: string;
}

export interface WsClientEndpoint {
  name?: string;
  url?: string;
  role?: string;
  reconnectIntervalMs?: number;
  accessToken?: string;
}

export interface HttpPostEndpoint {
  name?: string;
  url?: string;
  accessToken?: string;
  timeoutMs?: number;
}

export interface OneBotConfig {
  httpServers: HttpServerEndpoint[];
  httpPostEndpoints: HttpPostEndpoint[];
  wsServers: WsServerEndpoint[];
  wsClients: WsClientEndpoint[];
  musicSignUrl?: string;
}

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
  gpus: { name: string; vendor: string }[];
}

export interface LogEntry {
  id: number;
  time: string;
  level: 'debug' | 'info' | 'success' | 'warn' | 'error';
  scope: string;
  message: string;
  line: string;
}
