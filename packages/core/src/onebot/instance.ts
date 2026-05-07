import path from 'path';
import type { QQEventVariant } from '../bridge/events';
import type { Bridge } from '../bridge/bridge';
import type { QQInfo } from '../bridge/qq-info';
import { ApiHandler } from './api-handler';
import { EventConverter } from './event-converter';
import { MessageStore } from './message-store';
import { RKeyCache } from './instance-rkey';
import { buildApiContext } from './instance-context';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from './message-id';
import type { JsonObject, MessageMeta, OneBotConfig } from './types';
import { HttpTransport } from './http-transport';
import { HttpPostTransport } from './http-post-transport';
import { WsTransport } from './ws-transport';
import { createLogger } from '../utils/logger';

const log = createLogger('Event');

export class OneBotInstance {
  readonly uin: string;

  readonly qqInfo: QQInfo;
  private readonly bridge: Bridge;
  private readonly apiHandler: ApiHandler;
  private readonly eventConverter: EventConverter;
  private readonly messageStore: MessageStore;
  private readonly httpTransport: HttpTransport;
  private readonly httpPostTransport: HttpPostTransport;
  private readonly wsTransport: WsTransport;
  private readonly rkeyCache: RKeyCache;

  private readonly pids = new Set<number>();
  private online = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL = 30000;

  constructor(uin: string, qqInfo: QQInfo, bridge: Bridge, config: OneBotConfig) {
    this.uin = uin;
    this.qqInfo = qqInfo;
    this.bridge = bridge;

    this.eventConverter = new EventConverter();
    this.rkeyCache = new RKeyCache();
    this.eventConverter.setImageUrlResolver((element, isGroup) =>
      this.rkeyCache.resolveImageUrl(this.bridge, element, isGroup));
    this.eventConverter.setMediaUrlResolver(async (element, isGroup, sessionId) => {
      // Fetch URL from bridge if not already present
      if (!element.url) {
        try {
          if (element.type === 'file' && element.fileId) {
            element.url = isGroup
              ? await this.bridge.fetchGroupFileUrl(sessionId, element.fileId)
              : element.fileHash
                ? await this.bridge.fetchPrivateFileUrl(sessionId, element.fileId, element.fileHash)
                : '';
          } else if ((element.type === 'record' || element.type === 'video') && element.mediaNode) {
            if (isGroup) {
              element.url = element.type === 'record'
                ? await this.bridge.fetchGroupPttUrlByNode(sessionId, element.mediaNode)
                : await this.bridge.fetchGroupVideoUrlByNode(sessionId, element.mediaNode);
            } else {
              element.url = element.type === 'record'
                ? await this.bridge.fetchPrivatePttUrlByNode(element.mediaNode)
                : await this.bridge.fetchPrivateVideoUrlByNode(element.mediaNode);
            }
          }
        } catch { /* best-effort */ }
      }
      // Then apply RKey if needed
      return this.rkeyCache.resolveMediaUrl(this.bridge, element, isGroup);
    });
    this.eventConverter.setMessageIdResolver((isGroup, sessionId, sequence, eventName) =>
      hashMessageIdInt32(sequence, sessionId, eventName || (isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT)));
    this.messageStore = new MessageStore(path.join('data', this.uin, 'messages.json'));

    const context = buildApiContext({
      uin: this.uin,
      qqInfo: this.qqInfo,
      bridge: this.bridge,
      messageStore: this.messageStore,
      musicSignUrl: config.musicSignUrl,
      cacheMessageMeta: (messageId, meta) => this.cacheMessageMeta(messageId, meta),
    });
    this.apiHandler = new ApiHandler(context);

    this.httpTransport = new HttpTransport(config, {
      api: this.apiHandler,
    });

    this.httpPostTransport = new HttpPostTransport(config, {
      uin: this.uin,
      api: this.apiHandler,
    });

    this.wsTransport = new WsTransport(config, {
      uin: this.uin,
      api: this.apiHandler,
      buildLifecycleEvent: (subType) => this.makeLifecycleEvent(subType),
      buildHeartbeatEvent: () => this.makeHeartbeatEvent(),
    });

    this.httpTransport.start();
    this.httpPostTransport.start();
    this.wsTransport.start();
    this.startHeartbeat();
    this.rkeyCache.warmUp(this.bridge, this.uin);
  }

  reloadConfig(config: OneBotConfig): void {
    this.httpTransport.reloadConfig(config);
    this.httpPostTransport.reloadConfig(config);
    this.wsTransport.reloadConfig(config);
  }

  dispose(): void {
    this.online = false;
    this.stopHeartbeat();
    this.httpTransport.stop();
    this.httpPostTransport.stop();
    this.wsTransport.stop();
    this.messageStore.close();
  }

  onBridgeEvent(event: QQEventVariant): void {
    this.cacheMessageMetaFromBridgeEvent(event);

    void this.dispatchBridgeEventAsync(event);
  }

  private async dispatchBridgeEventAsync(event: QQEventVariant): Promise<void> {
    const converted = await this.eventConverter.convert(this.uin, event);
    if (!converted) return;

    this.dispatchEvent(converted);
  }

  addPid(pid: number): void {
    this.pids.add(pid);
  }

  removePid(pid: number): void {
    this.pids.delete(pid);
  }

  hasPid(pid: number): boolean {
    return this.pids.has(pid);
  }

  getPids(): number[] {
    return [...this.pids];
  }

  get empty(): boolean {
    return this.pids.size === 0;
  }

  private dispatchEvent(event: JsonObject): void {
    this.cacheMessageEvent(event);
    this.logReceivedMessage(event);
    this.wsTransport.publishEvent(event);
    this.httpPostTransport.publishEvent(event);
  }

  private logReceivedMessage(event: JsonObject): void {
    if (event.post_type !== 'message') return;

    const messageId = toInt(event.message_id);
    const isGroup = event.message_type === 'group';
    
    // Build message preview
    const parts: string[] = [];
    const message = event.message;
    
    if (Array.isArray(message)) {
      for (const seg of message) {
        if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
        const type = String(seg.type ?? '');
        const data: Record<string, unknown> = (
          typeof seg.data === 'object' && seg.data !== null && !Array.isArray(seg.data)
        ) ? seg.data : {};

        if (type === 'text' && data.text) {
          const text = String(data.text);
          const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
          parts.push(preview);
        } else if (type === 'image') {
          parts.push('[图片]');
        } else if (type === 'face') {
          parts.push('[表情]');
        } else if (type === 'at') {
          parts.push(`@${data.qq || ''}`);
        } else if (type === 'reply') {
          parts.push(`[回复:${data.id || ''}]`);
        } else if (type === 'record') {
          parts.push('[语音]');
        } else if (type === 'video') {
          parts.push('[视频]');
        } else {
          parts.push(`[${type}]`);
        }
      }
    }
    
    const content = parts.join(' ').trim() || '[空消息]';
    const idStr = `ID:${messageId}`;
    
    if (isGroup) {
      const groupId = toInt(event.group_id);
      const userId = toInt(event.user_id);
      const sender = event.sender as any;
      const nickname = sender?.card || sender?.nickname || String(userId);
      log.success(`群 ${groupId} | ${nickname}(${userId}): ${idStr} ${content}`);
    } else {
      const userId = toInt(event.user_id);
      const sender = event.sender as any;
      const nickname = sender?.nickname || String(userId);
      log.success(`私聊 ${nickname}(${userId}): ${idStr} ${content}`);
    }
  }

  private cacheMessageEvent(event: JsonObject): void {
    if (event.post_type !== 'message') return;

    const messageId = toInt(event.message_id);
    if (messageId === 0) return;

    const isGroup = event.message_type === 'group';
    const sessionId = isGroup ? toInt(event.group_id) : toInt(event.user_id);
    const sequence = toInt(event.message_seq);
    const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;

    if (sessionId === 0) return;
    this.messageStore.storeEvent(messageId, isGroup, sessionId, sequence, eventName, event);
  }

  private cacheMessageMetaFromBridgeEvent(event: QQEventVariant): void {
    if (event.kind === 'group_message') {
      const messageId = hashMessageIdInt32(event.msgSeq, event.groupId, GROUP_MESSAGE_EVENT);
      this.cacheMessageMeta(messageId, {
        isGroup: true,
        targetId: event.groupId,
        sequence: event.msgSeq,
        eventName: GROUP_MESSAGE_EVENT,
        clientSequence: 0,
        random: event.msgId,
        timestamp: event.time,
      });
      return;
    }

    if (event.kind === 'friend_message') {
      const messageId = hashMessageIdInt32(event.msgSeq, event.senderUin, PRIVATE_MESSAGE_EVENT);
      this.cacheMessageMeta(messageId, {
        isGroup: false,
        targetId: event.senderUin,
        sequence: event.msgSeq,
        eventName: PRIVATE_MESSAGE_EVENT,
        clientSequence: 0,
        random: event.msgId,
        timestamp: event.time,
      });
      return;
    }

    if (event.kind === 'temp_message') {
      const messageId = hashMessageIdInt32(event.msgSeq, event.senderUin, PRIVATE_MESSAGE_EVENT);
      this.cacheMessageMeta(messageId, {
        isGroup: false,
        targetId: event.senderUin,
        sequence: event.msgSeq,
        eventName: PRIVATE_MESSAGE_EVENT,
        clientSequence: 0,
        random: 0,
        timestamp: event.time,
      });
    }
  }

  private cacheMessageMeta(messageId: number, meta: MessageMeta): void {
    if (!Number.isInteger(messageId) || messageId === 0) return;
    this.messageStore.storeMeta(messageId, meta);
  }

  private makeLifecycleEvent(subType: 'connect' | 'enable' | 'disable'): JsonObject {
    const selfId = parseInt(this.uin, 10) || 0;
    const time = Math.floor(Date.now() / 1000);
    return {
      time,
      self_id: selfId,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: subType,
      status: {
        online: this.online,
        good: this.online,
      },
    };
  }

  // --- Heartbeat ---

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.dispatchEvent(this.makeHeartbeatEvent());
    }, OneBotInstance.HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref?.();
  }

  private makeHeartbeatEvent(): JsonObject {
    const selfId = parseInt(this.uin, 10) || 0;
    const time = Math.floor(Date.now() / 1000);
    return {
      time,
      self_id: selfId,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: this.online, good: this.online },
      interval: OneBotInstance.HEARTBEAT_INTERVAL,
    };
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}
