import fs from 'fs';
import path from 'path';
import type {
  HttpPostEndpoint,
  HttpServerEndpoint,
  JsonObject,
  OneBotConfig,
  WsClientEndpoint,
  WsRole,
  WsServerEndpoint,
} from './types';

const CONFIG_DIR = 'config';
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'onebot.json');

export function makeDefaultOneBotConfig(): OneBotConfig {
  return {
    httpServers: [{ host: '0.0.0.0', port: 3000, path: '/' }],
    httpPostEndpoints: [],
    wsServers: [{ host: '0.0.0.0', port: 3001 }],
    wsClients: [],
    musicSignUrl: '',
  };
}

export function loadOneBotConfig(uin: string): OneBotConfig {
  ensureConfigDir();

  const merged = deepClone(toJsonObject(makeDefaultOneBotConfig()));
  const globalConfig = tryLoadJson(DEFAULT_CONFIG_PATH);
  if (globalConfig) {
    deepMerge(merged, globalConfig);
  }

  const perUinPath = path.join(CONFIG_DIR, `onebot_${uin}.json`);
  const perUinConfig = tryLoadJson(perUinPath);
  if (perUinConfig) {
    deepMerge(merged, perUinConfig);
  }

  const config = fromJson(merged);
  let shouldSave = !perUinConfig;

  // Persist normalized endpoints and generated keys.
  merged.httpServers = config.httpServers.map((s) => {
    const out: JsonObject = {
      host: s.host,
      port: s.port,
      path: s.path ?? '/',
      accessToken: s.accessToken ?? '',
    };
    if (s.name) out.name = s.name;
    return out;
  });
  merged.httpPostEndpoints = config.httpPostEndpoints.map((e) => {
    const out: JsonObject = { url: e.url };
    if (e.name) out.name = e.name;
    if (e.accessToken) out.accessToken = e.accessToken;
    if (typeof e.timeoutMs === 'number') out.timeoutMs = e.timeoutMs;
    return out;
  });
  merged.wsServers = config.wsServers.map((s) => {
    const out: JsonObject = {
      host: s.host,
      port: s.port,
      path: s.path ?? '/',
      role: s.role ?? 'universal',
      accessToken: s.accessToken ?? '',
    };
    if (s.name) out.name = s.name;
    return out;
  });
  merged.wsClients = config.wsClients.map((c) => {
    const out: JsonObject = {
      url: c.url,
      role: c.role ?? 'universal',
      accessToken: c.accessToken ?? '',
    };
    if (c.name) out.name = c.name;
    if (typeof c.reconnectIntervalMs === 'number' && Number.isFinite(c.reconnectIntervalMs)) {
      out.reconnectIntervalMs = Math.max(1000, Math.trunc(c.reconnectIntervalMs));
    }
    return out;
  });
  merged.musicSignUrl = config.musicSignUrl ?? '';

  if (shouldSave) {
    saveJson(perUinPath, merged);
  }

  return config;
}

export function saveOneBotConfig(uin: string, config: OneBotConfig): void {
  ensureConfigDir();
  const perUinPath = path.join(CONFIG_DIR, `onebot_${uin}.json`);
  const jsonObj = toJsonObject(config);
  saveJson(perUinPath, jsonObj);
}

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function toJsonObject(config: OneBotConfig): JsonObject {
  return {
    httpServers: config.httpServers.map((s) => {
      const out: JsonObject = { host: s.host, port: s.port, path: s.path ?? '/', accessToken: s.accessToken ?? '' };
      if (s.name) out.name = s.name;
      return out;
    }),
    httpPostEndpoints: config.httpPostEndpoints.map((e) => {
      const out: JsonObject = { url: e.url };
      if (e.name) out.name = e.name;
      if (e.accessToken) out.accessToken = e.accessToken;
      if (typeof e.timeoutMs === 'number') out.timeoutMs = e.timeoutMs;
      return out;
    }),
    wsServers: config.wsServers.map((s) => {
      const out: JsonObject = { host: s.host, port: s.port, path: s.path ?? '/', role: s.role ?? 'universal', accessToken: s.accessToken ?? '' };
      if (s.name) out.name = s.name;
      return out;
    }),
    wsClients: config.wsClients.map((c) => {
      const out: JsonObject = {
        url: c.url,
        role: c.role ?? 'universal',
        accessToken: c.accessToken ?? '',
      };
      if (c.name) out.name = c.name;
      if (typeof c.reconnectIntervalMs === 'number' && Number.isFinite(c.reconnectIntervalMs)) {
        out.reconnectIntervalMs = Math.max(1000, Math.trunc(c.reconnectIntervalMs));
      }
      return out;
    }),
    musicSignUrl: config.musicSignUrl ?? '',
  };
}

function fromJson(json: JsonObject): OneBotConfig {
  const httpServers = toHttpServers(json.httpServers);
  const httpPostEndpoints = toHttpPostEndpoints(json.httpPostEndpoints);
  const wsServers = toWsServers(json.wsServers);
  const wsClients = toWsClients(json.wsClients);

  return {
    httpServers: httpServers.length > 0 ? httpServers : [{ host: '0.0.0.0', port: 3000, path: '/' }],
    httpPostEndpoints,
    wsServers: wsServers.length > 0 ? wsServers : [{ host: '0.0.0.0', port: 3001 }],
    wsClients,
    musicSignUrl: typeof json.musicSignUrl === 'string' ? json.musicSignUrl : '',
  };
}

function toHttpServers(value: unknown): HttpServerEndpoint[] {
  if (!Array.isArray(value)) return [];
  const result: HttpServerEndpoint[] = [];

  for (const item of value) {
    if (!isObject(item)) continue;
    const host = asString(item.host, '0.0.0.0');
    const port = asNumber(item.port, 3000);
    const pathValue = asString(item.path, '/');
    const endpoint: HttpServerEndpoint = { host, port, path: pathValue };
    const name = asString(item.name);
    if (name) endpoint.name = name;
    const token = asString(item.accessToken);
    if (token) endpoint.accessToken = token;
    result.push(endpoint);
  }

  return result;
}

function toHttpPostEndpoints(value: unknown): HttpPostEndpoint[] {
  if (!Array.isArray(value)) return [];
  const result: HttpPostEndpoint[] = [];

  for (const item of value) {
    if (!isObject(item)) continue;
    const url = asString(item.url);
    if (!url) continue;
    const endpoint: HttpPostEndpoint = { url };
    const name = asString(item.name);
    if (name) endpoint.name = name;
    const token = asString(item.accessToken);
    if (token) endpoint.accessToken = token;
    const timeout = asNumber(item.timeoutMs, 0);
    if (timeout > 0) endpoint.timeoutMs = timeout;
    result.push(endpoint);
  }

  return result;
}

function toWsServers(value: unknown): WsServerEndpoint[] {
  if (!Array.isArray(value)) return [];
  const result: WsServerEndpoint[] = [];

  for (const item of value) {
    if (!isObject(item)) continue;
    const host = asString(item.host, '0.0.0.0');
    const port = asNumber(item.port, 3001);
    const pathValue = asString(item.path, '/');
    const role = asRole(item.role, 'universal');
    const endpoint: WsServerEndpoint = { host, port, path: pathValue, role };
    const name = asString(item.name);
    if (name) endpoint.name = name;
    const token = asString(item.accessToken);
    if (token) endpoint.accessToken = token;
    result.push(endpoint);
  }

  return result;
}

function toWsClients(value: unknown): WsClientEndpoint[] {
  if (!Array.isArray(value)) return [];
  const result: WsClientEndpoint[] = [];

  for (const item of value) {
    if (!isObject(item)) continue;
    const url = asString(item.url);
    if (!url) continue;
    const role = asRole(item.role, 'universal');
    const reconnectIntervalMs = asNumber(item.reconnectIntervalMs, 5000);
    const endpoint: WsClientEndpoint = { url, role, reconnectIntervalMs };
    const name = asString(item.name);
    if (name) endpoint.name = name;
    const token = asString(item.accessToken);
    if (token) endpoint.accessToken = token;
    result.push(endpoint);
  }

  return result;
}

function asRole(value: unknown, fallback: WsRole): WsRole {
  const text = asString(value, fallback);
  return text === 'api' || text === 'event' || text === 'universal' ? text : fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  }
  return fallback;
}

function tryLoadJson(filePath: string): JsonObject | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveJson(filePath: string, json: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
}

function deepClone(obj: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(obj)) as JsonObject;
}

function deepMerge(base: JsonObject, override: JsonObject): void {
  for (const [key, value] of Object.entries(override)) {
    if (isObject(base[key]) && isObject(value)) {
      deepMerge(base[key] as JsonObject, value);
    } else {
      base[key] = value as never;
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
