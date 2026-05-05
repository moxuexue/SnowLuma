import fs from 'fs';
import path from 'path';

export interface RuntimeConfig {
  webuiPort?: number;
}

const CONFIG_DIR = 'config';
const RUNTIME_CONFIG_PATH = path.join(CONFIG_DIR, 'runtime.json');

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  webuiPort: 5099,
};

export function loadRuntimeConfig(): RuntimeConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const loaded = tryLoadRuntimeConfig();
  if (!loaded) {
    saveRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
    return { ...DEFAULT_RUNTIME_CONFIG };
  }

  const normalized: RuntimeConfig = {
    webuiPort: normalizePort(loaded.webuiPort ?? 5099, 5099),
  };

  if (
    normalized.webuiPort !== loaded.webuiPort
  ) {
    saveRuntimeConfig(normalized);
  }

  return normalized;
}

function tryLoadRuntimeConfig(): RuntimeConfig | null {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return null;

  try {
    const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return null;

    return {
      webuiPort: normalizePort(parsed.webuiPort ?? 5099, 5099),
    };
  } catch {
    return null;
  }
}

function saveRuntimeConfig(config: RuntimeConfig): void {
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function normalizePort(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n > 0 && n <= 65535) return n;
    return fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      const port = Math.trunc(n);
      if (port > 0 && port <= 65535) return port;
    }
  }
  return fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
