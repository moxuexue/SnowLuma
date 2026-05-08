import type { HttpClientNetwork, JsonObject, OneBotConfig } from './types';
import { createLogger } from '../utils/logger';
import {
  buildDispatchPayload,
  pickDispatchJson,
  resolveReportOptions,
  type DispatchPayload,
  type EventReportOptions,
} from './event-filter';

export interface HttpPostTransportContext {
  uin: string;
  api: import('./api-handler').ApiHandler;
}

const log = createLogger('OneBot.POST');
const DEFAULT_TIMEOUT_MS = 5000;

interface ResolvedClient {
  network: HttpClientNetwork;
  options: EventReportOptions;
}

export class HttpPostTransport {
  private readonly context: HttpPostTransportContext;
  private clients = new Map<string, ResolvedClient>();
  private stopped = false;

  constructor(config: OneBotConfig, context: HttpPostTransportContext) {
    this.clients = resolveClients(config);
    this.context = context;
  }

  start(): void {
    this.stopped = false;
    if (this.clients.size > 0) {
      log.info('configured %d HTTP POST adapter(s): %s', this.clients.size, [...this.clients.keys()].join(', '));
    }
  }

  reloadConfig(config: OneBotConfig): void {
    this.clients = resolveClients(config);
    log.info('reloaded %d HTTP POST adapter(s)', this.clients.size);
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Forward one canonical event to every active HTTP push client.
   *
   * The instance pre-builds the {@link DispatchPayload} so this method only
   * picks the right pre-serialized variant per client (zero extra
   * `JSON.stringify` calls). The raw `event` is still kept around because the
   * quick-operation handler reads structured fields from it.
   */
  publishEvent(event: JsonObject, payload?: DispatchPayload): void {
    if (this.stopped || this.clients.size === 0) return;

    const dispatch = payload ?? buildDispatchPayload(event);
    for (const client of this.clients.values()) {
      const json = pickDispatchJson(dispatch, client.options);
      if (json === null) continue;
      void this.postEvent(client.network, json, event);
    }
  }

  private async postEvent(network: HttpClientNetwork, payload: string, event: JsonObject): Promise<void> {
    if (this.stopped) return;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'OneBot',
      'X-Self-ID': this.context.uin,
    };

    if (network.accessToken) {
      headers['X-Signature'] = await computeHmacSha1(network.accessToken, payload);
    }

    const timeoutMs = network.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const response = await fetch(network.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // OneBot v11: if the response has a JSON body, it's a quick operation
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const body = await response.text();
          if (body.trim()) {
            await this.handleQuickOperation(event, body);
          }
        }
      } else {
        log.warn('[%s] POST %s returned %d', network.name, network.url, response.status);
      }
    } catch (error) {
      if (!this.stopped) {
        log.warn('[%s] POST %s failed: %s', network.name, network.url, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async handleQuickOperation(event: JsonObject, responseBody: string): Promise<void> {
    try {
      const operation = JSON.parse(responseBody) as Record<string, unknown>;
      if (!operation || typeof operation !== 'object') return;

      await executeQuickOperation(event, operation, this.context.api);
    } catch (error) {
      log.warn('quick operation failed: %s', error instanceof Error ? error.message : String(error));
    }
  }
}

function resolveClients(config: OneBotConfig): Map<string, ResolvedClient> {
  const out = new Map<string, ResolvedClient>();
  for (const network of config.networks.httpClients) {
    if (network.enabled === false) continue;
    if (!network.url) continue;
    out.set(network.name, {
      network,
      options: resolveReportOptions(network),
    });
  }
  return out;
}

async function computeHmacSha1(secret: string, payload: string): Promise<string> {
  const { createHmac } = await import('crypto');
  return 'sha1=' + createHmac('sha1', secret).update(payload).digest('hex');
}

/**
 * Execute a quick operation based on the event type and the response body.
 * This implements the .handle_quick_operation hidden API behavior.
 * See: https://github.com/botuniverse/onebot-11/blob/master/api/hidden.md
 */
export async function executeQuickOperation(
  event: JsonObject,
  operation: Record<string, unknown>,
  api: import('./api-handler').ApiHandler,
): Promise<void> {
  const postType = event.post_type as string;

  if (postType === 'message') {
    // Quick reply
    if (operation.reply !== undefined && operation.reply !== null && operation.reply !== '') {
      const messageType = event.message_type as string;
      const autoEscape = !!operation.auto_escape;

      if (messageType === 'group') {
        const params: JsonObject = {
          group_id: event.group_id as number,
          message: operation.reply as import('./types').JsonValue,
          auto_escape: autoEscape,
        };
        // at_sender defaults to true for group messages
        if (operation.at_sender !== false && event.user_id) {
          // Prepend an @ segment
          const atSegment = { type: 'at', data: { qq: String(event.user_id) } };
          if (typeof operation.reply === 'string') {
            params.message = [atSegment, { type: 'text', data: { text: operation.reply as string } }] as import('./types').JsonValue;
            params.auto_escape = false;
          } else if (Array.isArray(operation.reply)) {
            params.message = [atSegment, ...(operation.reply as unknown[])] as import('./types').JsonValue;
          }
        }
        await api.handle('send_group_msg', params);
      } else if (messageType === 'private') {
        await api.handle('send_private_msg', {
          user_id: event.user_id as number,
          message: operation.reply as import('./types').JsonValue,
          auto_escape: autoEscape,
        });
      }
    }

    // Quick delete
    if (operation.delete) {
      await api.handle('delete_msg', { message_id: event.message_id as number });
    }

    // Quick ban (group only)
    if (operation.ban && event.message_type === 'group') {
      const duration = typeof operation.ban_duration === 'number' ? operation.ban_duration : 1800;
      await api.handle('set_group_ban', {
        group_id: event.group_id as number,
        user_id: event.user_id as number,
        duration: duration as import('./types').JsonValue,
      });
    }

    // Quick kick (group only)
    if (operation.kick && event.message_type === 'group') {
      await api.handle('set_group_kick', {
        group_id: event.group_id as number,
        user_id: event.user_id as number,
        reject_add_request: !!operation.reject_add_request as unknown as import('./types').JsonValue,
      });
    }
  }

  if (postType === 'request') {
    if (operation.approve !== undefined) {
      const requestType = event.request_type as string;
      if (requestType === 'friend') {
        await api.handle('set_friend_add_request', {
          flag: event.flag as string,
          approve: operation.approve as import('./types').JsonValue,
          remark: (operation.remark ?? '') as import('./types').JsonValue,
        });
      } else if (requestType === 'group') {
        await api.handle('set_group_add_request', {
          flag: event.flag as string,
          sub_type: event.sub_type as string,
          approve: operation.approve as import('./types').JsonValue,
          reason: (operation.reason ?? '') as import('./types').JsonValue,
        });
      }
    }
  }
}
