import { WebSocket, WebSocketServer } from '@snowluma/websocket';
import type { IncomingMessage } from 'http';
import type { ApiHandler } from './api-handler';
import type { JsonObject, OneBotConfig, WsClientNetwork, WsRole, WsServerNetwork } from './types';
import { createLogger } from '../utils/logger';
import {
  buildDispatchPayload,
  pickDispatchJson,
  resolveReportOptions,
  shapeEventForAdapter,
  type DispatchPayload,
  type EventReportOptions,
} from './event-filter';

interface ForwardConnection {
  socket: WebSocket;
  role: WsRole;
  options: EventReportOptions;
  serverName: string;
}

interface ReverseConnection {
  socket: WebSocket;
  role: WsRole;
  options: EventReportOptions;
  endpointUrl: string;
  reconnectIntervalMs: number;
  name: string;
}

interface RunningWsServer {
  wss: WebSocketServer;
  signature: string;
  network: WsServerNetwork;
  options: EventReportOptions;
}

interface RunningWsClient {
  network: WsClientNetwork;
  signature: string;
  options: EventReportOptions;
}

export interface WsTransportContext {
  uin: string;
  api: ApiHandler;
  buildLifecycleEvent: (subType: 'connect' | 'enable' | 'disable') => JsonObject;
  buildHeartbeatEvent: () => JsonObject;
}

const log = createLogger('OneBot.WS');

export class WsTransport {
  private readonly context: WsTransportContext;

  private readonly servers = new Map<string, RunningWsServer>();
  private readonly clientStates = new Map<string, RunningWsClient>();
  private readonly forwardConnections = new Map<WebSocket, ForwardConnection>();
  private readonly reverseConnections = new Map<string, ReverseConnection>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private serverNetworks: WsServerNetwork[] = [];
  private clientNetworks: WsClientNetwork[] = [];
  private stopped = false;

  constructor(config: OneBotConfig, context: WsTransportContext) {
    this.serverNetworks = activeServers(config);
    this.clientNetworks = activeClients(config);
    this.context = context;
    for (const network of this.clientNetworks) {
      this.clientStates.set(network.name, {
        network,
        signature: wsClientSignature(network),
        options: resolveReportOptions(network),
      });
    }
  }

  start(): void {
    this.stopped = false;
    for (const network of this.serverNetworks) this.startServerEndpoint(network);
    for (const network of this.clientNetworks) this.startClientEndpoint(network.name);
  }

  reloadConfig(config: OneBotConfig): void {
    const nextServers = activeServers(config);
    const nextClients = activeClients(config);
    const nextServerByName = new Map(nextServers.map((n) => [n.name, n] as const));
    const nextClientByName = new Map(nextClients.map((n) => [n.name, n] as const));

    // --- WS Servers ---
    for (const [name, running] of [...this.servers]) {
      const next = nextServerByName.get(name);
      if (!next || wsServerSignature(next) !== running.signature) {
        running.wss.close();
        this.servers.delete(name);
        // Drop forward connections that belonged to the closed adapter.
        for (const [socket, conn] of [...this.forwardConnections]) {
          if (conn.serverName === name) {
            safeClose(socket);
            this.forwardConnections.delete(socket);
          }
        }
        log.info('stopped forward server [%s]', name);
      } else {
        // Same binding — refresh options so reload picks up format changes.
        running.network = next;
        running.options = resolveReportOptions(next);
        for (const conn of this.forwardConnections.values()) {
          if (conn.serverName === name) conn.options = running.options;
        }
      }
    }
    for (const network of nextServers) {
      if (!this.servers.has(network.name)) this.startServerEndpoint(network);
    }

    // --- WS Clients (reverse) ---
    for (const [name, state] of [...this.clientStates]) {
      const next = nextClientByName.get(name);
      const sig = next ? wsClientSignature(next) : null;
      if (!next || sig !== state.signature) {
        const conn = this.reverseConnections.get(name);
        if (conn) {
          safeClose(conn.socket);
          this.reverseConnections.delete(name);
        }
        const timer = this.reconnectTimers.get(name);
        if (timer) {
          clearTimeout(timer);
          this.reconnectTimers.delete(name);
        }
        this.clientStates.delete(name);
        log.info('stopped reverse client [%s]', name);
      } else {
        state.network = next;
        state.options = resolveReportOptions(next);
        const conn = this.reverseConnections.get(name);
        if (conn) conn.options = state.options;
      }
    }
    for (const network of nextClients) {
      if (!this.clientStates.has(network.name)) {
        this.clientStates.set(network.name, {
          network,
          signature: wsClientSignature(network),
          options: resolveReportOptions(network),
        });
        if (!this.stopped) this.startClientEndpoint(network.name);
      }
    }

    this.serverNetworks = nextServers;
    this.clientNetworks = nextClients;
  }

  stop(): void {
    // Final lifecycle broadcast before we mark ourselves stopped.
    this.publishEvent(this.context.buildLifecycleEvent('disable'));
    this.stopped = true;

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const socket of this.forwardConnections.keys()) {
      safeClose(socket);
    }
    this.forwardConnections.clear();

    for (const conn of this.reverseConnections.values()) {
      safeClose(conn.socket);
    }
    this.reverseConnections.clear();

    for (const { wss } of this.servers.values()) {
      wss.close();
    }
    this.servers.clear();
    this.clientStates.clear();
  }

  /**
   * Fan out one canonical event to every event-receiving WS connection.
   *
   * The instance pre-builds the {@link DispatchPayload} (two JSON variants at
   * most) so each connection is served with a single O(1) pick + send rather
   * than re-shaping or re-serializing the event itself. The raw `event` is
   * accepted so ad-hoc callers (e.g. `stop()`) can dispatch without allocating
   * a payload at the call site.
   */
  publishEvent(event: JsonObject, payload?: DispatchPayload): void {
    const dispatch = payload ?? buildDispatchPayload(event);

    for (const conn of this.forwardConnections.values()) {
      if (conn.role !== 'event' && conn.role !== 'universal') continue;
      const json = pickDispatchJson(dispatch, conn.options);
      if (json === null) continue;
      safeSend(conn.socket, json);
    }

    for (const conn of this.reverseConnections.values()) {
      if (conn.role !== 'event' && conn.role !== 'universal') continue;
      const json = pickDispatchJson(dispatch, conn.options);
      if (json === null) continue;
      safeSend(conn.socket, json);
    }
  }

  private startServerEndpoint(network: WsServerNetwork): void {
    const wss = new WebSocketServer({
      host: network.host ?? '0.0.0.0',
      port: network.port,
      path: network.path ?? '/',
    });

    const running: RunningWsServer = {
      wss,
      signature: wsServerSignature(network),
      network,
      options: resolveReportOptions(network),
    };
    this.servers.set(network.name, running);

    wss.on('listening', () => {
      log.success('[%s] listening %s:%d%s', network.name, network.host ?? '0.0.0.0', network.port, network.path ?? '/');
    });

    wss.on('connection', (socket, request) => {
      if (!isAuthorized(request, running.network.accessToken ?? '')) {
        safeClose(socket, 1008, 'invalid access token');
        return;
      }

      const role = running.network.role ?? classifyForwardRole(request);
      const conn: ForwardConnection = {
        socket,
        role,
        options: running.options,
        serverName: running.network.name,
      };
      this.forwardConnections.set(socket, conn);

      socket.on('message', (raw: Buffer) => {
        void this.handleApiMessage(socket, role, raw);
      });

      socket.on('close', () => {
        this.forwardConnections.delete(socket);
      });

      socket.on('error', (error: Error) => {
        log.warn('[%s] forward socket error: %s', running.network.name, error instanceof Error ? error.message : String(error));
      });

      this.sendBootstrapMetaEvents(socket, role, conn.options);
    });

    wss.on('error', (error: Error) => {
      log.warn('[%s] server error: %s', network.name, error instanceof Error ? error.message : String(error));
    });
  }

  private startClientEndpoint(name: string): void {
    const state = this.clientStates.get(name);
    if (!state || this.stopped) return;
    if (this.reverseConnections.has(name) || this.reconnectTimers.has(name)) return;

    const network = state.network;
    const role = network.role ?? 'universal';
    const headers: Record<string, string> = {
      'User-Agent': 'OneBot',
      'X-Self-ID': this.context.uin,
      'X-Client-Role': role,
    };
    if (network.accessToken) headers.Authorization = `Bearer ${network.accessToken}`;

    const socket = new WebSocket(network.url, { headers });
    const conn: ReverseConnection = {
      socket,
      role,
      options: state.options,
      endpointUrl: network.url,
      reconnectIntervalMs: Math.max(1000, network.reconnectIntervalMs ?? 5000),
      name,
    };
    this.reverseConnections.set(name, conn);

    socket.on('open', () => {
      log.info('[%s] reverse connected %s', name, network.url);
      this.sendBootstrapMetaEvents(socket, role, state.options);
    });

    socket.on('message', (raw: Buffer) => {
      void this.handleApiMessage(socket, role, raw);
    });

    socket.on('close', () => {
      this.reverseConnections.delete(name);
      if (this.stopped) return;
      if (!this.clientStates.has(name)) return;
      if (this.reconnectTimers.has(name)) return;

      const timer = setTimeout(() => {
        this.reconnectTimers.delete(name);
        if (this.stopped || !this.clientStates.has(name)) return;
        this.startClientEndpoint(name);
      }, conn.reconnectIntervalMs);
      timer.unref?.();
      this.reconnectTimers.set(name, timer);
    });

    socket.on('error', (error: Error) => {
      log.warn('[%s] reverse error %s: %s', name, network.url, error instanceof Error ? error.message : String(error));
    });
  }

  private async handleApiMessage(socket: WebSocket, role: WsRole, raw: Buffer | string): Promise<void> {
    if (role !== 'api' && role !== 'universal') return;

    const text = rawDataToString(raw);
    if (!text) return;

    const response = await this.context.api.processRequest(text);
    safeSend(socket, response);
  }

  private sendBootstrapMetaEvents(socket: WebSocket, role: WsRole, options: EventReportOptions): void {
    if (role !== 'event' && role !== 'universal') return;

    const events = [
      this.context.buildLifecycleEvent('connect'),
      this.context.buildLifecycleEvent('enable'),
      this.context.buildHeartbeatEvent(),
    ];
    for (const event of events) {
      const shaped = shapeEventForAdapter(event, options);
      if (!shaped) continue;
      safeSend(socket, JSON.stringify(shaped));
    }
  }
}

function classifyForwardRole(request: IncomingMessage): WsRole {
  const path = parseRequestPath(request.url ?? '/');
  if (path.endsWith('/api')) return 'api';
  if (path.endsWith('/event')) return 'event';
  return 'universal';
}

function parseRequestPath(urlValue: string): string {
  try {
    return new URL(urlValue, 'ws://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function normalizeWsPath(pathValue: string | undefined): string {
  const path = (pathValue ?? '/').trim() || '/';
  if (path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function activeServers(config: OneBotConfig): WsServerNetwork[] {
  return config.networks.wsServers.filter((n) => n.enabled !== false);
}

function activeClients(config: OneBotConfig): WsClientNetwork[] {
  return config.networks.wsClients.filter((n) => n.enabled !== false && !!n.url);
}

function wsServerSignature(network: WsServerNetwork): string {
  return `${network.host ?? '0.0.0.0'}:${network.port}${normalizeWsPath(network.path)}#${network.role ?? 'auto'}#${network.accessToken ?? ''}`;
}

function wsClientSignature(network: WsClientNetwork): string {
  const role = network.role ?? 'universal';
  const reconnectIntervalMs = Math.max(1000, network.reconnectIntervalMs ?? 5000);
  return `${network.url}#${role}#${reconnectIntervalMs}#${network.accessToken ?? ''}`;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  if (!token) return true;
  // 1. Header auth
  const rawAuth = request.headers.authorization;
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth ?? '';
  if (auth === `Bearer ${token}`) return true;

  // 2. Query string auth
  try {
    const url = new URL(request.url ?? '/', 'ws://127.0.0.1');
    if (url.searchParams.get('access_token') === token) {
      return true;
    }
  } catch {}

  return false;
}

function rawDataToString(raw: Buffer | string | ArrayBuffer | ArrayBufferView | Buffer[]): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw)).toString('utf8');
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  }
  return '';
}

function safeSend(socket: WebSocket, payload: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(payload, (error?: Error | null) => {
    if (error) {
      log.warn('send error: %s', error instanceof Error ? error.message : String(error));
    }
  });
}

function safeClose(socket: WebSocket, code = 1000, reason = 'normal'): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  socket.close(code, reason);
}
