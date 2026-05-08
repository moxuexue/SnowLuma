import type { MessageElement, QQEventVariant } from '../bridge/events';
import type { JsonArray, JsonObject } from './types';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from './message-id';

export type ImageUrlResolver = (element: MessageElement, isGroup: boolean) => string;
export type MediaUrlResolver = (element: MessageElement, isGroup: boolean, sessionId: number) => Promise<string>;
export type MessageIdResolver = (isGroup: boolean, sessionId: number, sequence: number, eventName: string) => number;

export class EventConverter {
  private imageUrlResolver_: ImageUrlResolver | null = null;
  private mediaUrlResolver_: MediaUrlResolver | null = null;
  private messageIdResolver_: MessageIdResolver | null = null;

  setImageUrlResolver(resolver: ImageUrlResolver): void {
    this.imageUrlResolver_ = resolver;
  }

  setMediaUrlResolver(resolver: MediaUrlResolver): void {
    this.mediaUrlResolver_ = resolver;
  }

  setMessageIdResolver(resolver: MessageIdResolver): void {
    this.messageIdResolver_ = resolver;
  }

  async convert(instanceUin: string, event: QQEventVariant): Promise<JsonObject | null> {
    const selfId = parseSelfId(instanceUin);

    switch (event.kind) {
      case 'friend_message':
        {
          const isSelf = event.senderUin === selfId;
          const postType = isSelf ? 'message_sent' : 'message';
          const messageId = this.resolveMessageId(false, event.senderUin, event.msgSeq, PRIVATE_MESSAGE_EVENT);
          const segments = await elementsToJson(event.elements, false, event.senderUin, this.imageUrlResolver_, this.mediaUrlResolver_, this.messageIdResolver_);
        return {
          time: event.time,
          self_id: selfId,
          post_type: postType,
          message_type: 'private',
          sub_type: 'friend',
          message_id: messageId,
          message_seq: event.msgSeq,
          user_id: event.senderUin,
          message: segments,
          raw_message: segmentsToRawMessage(segments),
          font: 0,
          sender: {
            user_id: event.senderUin,
            nickname: event.senderNick,
            sex: 'unknown',
            age: 0,
          },
        };
      }

      case 'group_message':
        {
          const isSelf = event.senderUin === selfId;
          const postType = isSelf ? 'message_sent' : 'message';
          const messageId = this.resolveMessageId(true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT);
          const segments = await elementsToJson(event.elements, true, event.groupId, this.imageUrlResolver_, this.mediaUrlResolver_, this.messageIdResolver_);
        return {
          time: event.time,
          self_id: selfId,
          post_type: postType,
          message_type: 'group',
          sub_type: 'normal',
          message_id: messageId,
          message_seq: event.msgSeq,
          group_id: event.groupId,
          user_id: event.senderUin,
          message: segments,
          raw_message: segmentsToRawMessage(segments),
          font: 0,
          sender: {
            user_id: event.senderUin,
            nickname: event.senderNick,
            card: event.senderCard,
            role: event.senderRole || 'member',
            sex: 'unknown',
            age: 0,
          },
          anonymous: null,
        };
      }

      case 'temp_message':
        {
          const isSelf = event.senderUin === selfId;
          const postType = isSelf ? 'message_sent' : 'message';
          const messageId = this.resolveMessageId(false, event.senderUin, event.msgSeq, PRIVATE_MESSAGE_EVENT);
          const segments = await elementsToJson(event.elements, false, event.senderUin, this.imageUrlResolver_, this.mediaUrlResolver_, this.messageIdResolver_);
        return {
          time: event.time,
          self_id: selfId,
          post_type: postType,
          message_type: 'private',
          sub_type: 'group',
          message_id: messageId,
          message_seq: event.msgSeq,
          user_id: event.senderUin,
          message: segments,
          raw_message: segmentsToRawMessage(segments),
          font: 0,
          sender: {
            user_id: event.senderUin,
            nickname: event.senderNick,
            sex: 'unknown',
            age: 0,
          },
        };
      }

      case 'group_member_join':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_increase',
          sub_type: event.operatorUin === event.userUin ? 'approve' : 'invite',
          group_id: event.groupId,
          operator_id: event.operatorUin,
          user_id: event.userUin,
        };

      case 'group_member_leave':
        {
          let subType: string;
          if (event.isKick) {
            subType = event.userUin === parseSelfId(instanceUin) ? 'kick_me' : 'kick';
          } else {
            subType = 'leave';
          }
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_decrease',
          sub_type: subType,
          group_id: event.groupId,
          operator_id: event.operatorUin,
          user_id: event.userUin,
        };
      }

      case 'group_mute':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_ban',
          sub_type: event.duration > 0 ? 'ban' : 'lift_ban',
          group_id: event.groupId,
          operator_id: event.operatorUin,
          user_id: event.userUin,
          duration: event.duration,
        };

      case 'group_admin':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_admin',
          sub_type: event.set ? 'set' : 'unset',
          group_id: event.groupId,
          user_id: event.userUin,
        };

      case 'friend_recall':
        {
          const messageId = this.resolveMessageId(false, event.userUin, event.msgSeq, PRIVATE_MESSAGE_EVENT);
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'friend_recall',
          user_id: event.userUin,
          message_id: messageId,
        };
      }

      case 'group_recall':
        {
          const messageId = this.resolveMessageId(true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT);
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_recall',
          group_id: event.groupId,
          operator_id: event.operatorUin,
          user_id: event.authorUin,
          message_id: messageId,
        };
      }

      case 'friend_request':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'request',
          request_type: 'friend',
          user_id: event.fromUin,
          comment: event.message,
          flag: event.flag,
        };

      case 'group_invite':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'request',
          request_type: 'group',
          sub_type: event.subType || 'invite',
          group_id: event.groupId,
          user_id: event.fromUin,
          comment: event.message,
          flag: event.flag,
        };

      case 'friend_poke':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'notify',
          sub_type: 'poke',
          user_id: event.userUin,
          target_id: event.targetUin,
          action: event.action,
          suffix: event.suffix,
          action_img_url: event.actionImgUrl,
        };

      case 'group_poke':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'notify',
          sub_type: 'poke',
          group_id: event.groupId,
          user_id: event.userUin,
          target_id: event.targetUin,
          action: event.action,
          suffix: event.suffix,
          action_img_url: event.actionImgUrl,
        };

      case 'group_essence':
        {
          const messageId = this.resolveMessageId(true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT);
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'essence',
          sub_type: event.set ? 'add' : 'delete',
          group_id: event.groupId,
          user_id: event.senderUin,
          sender_id: event.senderUin,
          operator_id: event.operatorUin,
          message_id: messageId,
          message_seq: event.msgSeq,
          random: event.random,
        };
      }

      case 'group_file_upload':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_upload',
          group_id: event.groupId,
          user_id: event.userUin,
          file: {
            id: event.fileId,
            name: event.fileName,
            size: event.fileSize,
            busid: event.busId,
          },
        };

      case 'friend_add':
        return {
          time: event.time,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'friend_add',
          user_id: event.userUin,
        };

      default:
        return null;
    }
  }

  private resolveMessageId(isGroup: boolean, sessionId: number, sequence: number, eventName: string): number {
    if (this.messageIdResolver_) {
      const resolved = this.messageIdResolver_(isGroup, sessionId, sequence, eventName);
      if (Number.isInteger(resolved) && resolved !== 0) return resolved;
    }
    const seq = Math.trunc(sequence);
    return seq === 0 ? 0 : seq;
  }
}

function parseSelfId(instanceUin: string): number {
  const parsed = Number.parseInt(instanceUin, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function elementsToJson(
  elements: MessageElement[],
  isGroup: boolean,
  sessionId: number,
  resolver?: ImageUrlResolver | null,
  mediaResolver?: MediaUrlResolver | null,
  messageIdResolver?: MessageIdResolver | null,
): Promise<JsonArray> {
  const result: JsonArray = [];
  for (const element of elements) {
    result.push(await elementToSegment(element, isGroup, sessionId, resolver, mediaResolver, messageIdResolver));
  }
  return result;
}

export async function elementsToOneBotSegments(
  elements: MessageElement[],
  isGroup: boolean,
  sessionId: number,
  resolver?: ImageUrlResolver | null,
  mediaResolver?: MediaUrlResolver | null,
  messageIdResolver?: MessageIdResolver | null,
): Promise<JsonArray> {
  return elementsToJson(elements, isGroup, sessionId, resolver, mediaResolver, messageIdResolver);
}

async function elementToSegment(
  element: MessageElement,
  isGroup: boolean,
  sessionId: number,
  resolver?: ImageUrlResolver | null,
  mediaResolver?: MediaUrlResolver | null,
  messageIdResolver?: MessageIdResolver | null,
): Promise<JsonObject> {
  if (element.type === 'text') {
    return { type: 'text', data: { text: element.text ?? '' } };
  }

  if (element.type === 'face') {
    return { type: 'face', data: { id: String(element.faceId ?? 0) } };
  }

  if (element.type === 'image') {
    const url = resolver ? resolver(element, isGroup) : (element.imageUrl ?? '');
    return {
      type: 'image',
      data: {
        url,
        file: element.fileId ?? '',
      },
    };
  }

  if (element.type === 'at') {
    const qq = (element.uid === 'all' || element.targetUin === 0)
      ? 'all'
      : String(element.targetUin ?? 0);
    return { type: 'at', data: { qq } };
  }

  if (element.type === 'reply') {
    const id = resolveReplyId(isGroup, sessionId, element.replySeq ?? 0, messageIdResolver);
    return { type: 'reply', data: { id: String(id) } };
  }

  if (element.type === 'record') {
    const url = mediaResolver ? await mediaResolver(element, isGroup, sessionId) : (element.url ?? '');
    return {
      type: 'record',
      data: {
        file: element.fileName ?? element.fileId ?? '',
        url,
      },
    };
  }

  if (element.type === 'video') {
    const url = mediaResolver ? await mediaResolver(element, isGroup, sessionId) : (element.url ?? '');
    return {
      type: 'video',
      data: {
        file: element.fileName ?? element.fileId ?? '',
        url,
      },
    };
  }

  if (element.type === 'json') {
    return { type: 'json', data: { data: element.text ?? '' } };
  }

  if (element.type === 'xml') {
    return {
      type: 'xml',
      data: {
        data: element.text ?? '',
        resid: element.subType ?? 35,
      },
    };
  }

  if (element.type === 'file') {
    const url = mediaResolver ? await mediaResolver(element, isGroup, sessionId) : (element.url ?? '');
    return {
      type: 'file',
      data: {
        name: element.fileName ?? '',
        size: element.fileSize ?? 0,
        id: element.fileId ?? '',
        url,
        file_hash: element.fileHash ?? '',
      },
    };
  }

  if (element.type === 'mface') {
    return {
      type: 'mface',
      data: {
        name: element.text ?? '',
        tab_id: element.faceId ?? 0,
        sub_type: element.subType ?? 0,
      },
    };
  }

  if (element.type === 'poke') {
    return {
      type: 'poke',
      data: {
        type: element.subType ?? 0,
      },
    };
  }

  if (!isGroup && element.type === 'at') {
    return { type: 'text', data: { text: element.text ?? '' } };
  }

  return { type: element.type, data: {} };
}

// --- CQ code raw_message generation (from already-resolved JSON segments) ---

function cqEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;');
}

function segmentsToRawMessage(segments: JsonArray): string {
  return segments.map(seg => segmentToCQ(seg as JsonObject)).join('');
}

function segmentToCQ(seg: JsonObject): string {
  const type = String(seg.type ?? '');
  const data = (seg.data ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'text':
      return cqEscape(String(data.text ?? ''));
    case 'face':
      return `[CQ:face,id=${data.id ?? 0}]`;
    case 'image':
      return `[CQ:image,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    case 'at':
      return `[CQ:at,qq=${data.qq ?? ''}]`;
    case 'reply':
      return `[CQ:reply,id=${data.id ?? 0}]`;
    case 'record':
      return `[CQ:record,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    case 'video':
      return `[CQ:video,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    case 'json':
      return `[CQ:json,data=${cqEscape(String(data.data ?? ''))}]`;
    case 'xml':
      return `[CQ:xml,data=${cqEscape(String(data.data ?? ''))}]`;
    case 'forward':
      return `[CQ:forward,id=${cqEscape(String(data.id ?? ''))}]`;
    case 'mface':
      return `[CQ:mface,name=${cqEscape(String(data.name ?? ''))}]`;
    case 'poke':
      return `[CQ:poke,type=${data.type ?? 0}]`;
    case 'file':
      return `[CQ:file,name=${cqEscape(String(data.name ?? ''))},size=${data.size ?? 0},id=${cqEscape(String(data.id ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    default:
      return `[CQ:${type}]`;
  }
}

function resolveReplyId(
  isGroup: boolean,
  sessionId: number,
  sequence: number,
  resolver?: MessageIdResolver | null,
): number {
  const seq = Math.trunc(sequence);
  if (seq === 0) return 0;

  if (resolver) {
    const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
    const resolved = resolver(isGroup, sessionId, seq, eventName);
    if (Number.isInteger(resolved) && resolved !== 0) return resolved;
  }

  return seq;
}
