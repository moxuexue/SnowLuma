// Element Builder — converts internal MessageElement[] into proto Elem objects
// for encoding with protoEncode(SendMessageRequestSchema).
// Port of src/bridge/src/bridge_messages.cpp build_send_elems()

import type { Bridge } from '../bridge';
import type { MessageElement } from '../events';
import type { ProtoDecoded } from '../../protobuf/decode';
import { protoEncode } from '../../protobuf/decode';
import {
  ElemSchema,
} from '../proto/element';
import {
  MentionExtraSendSchema,
  MarkdownDataSchema,
} from '../proto/action';
import { uploadImageMsgInfo } from '../highway/image-upload';

type ProtoElem = Partial<ProtoDecoded<typeof ElemSchema>>;

export interface SendContext {
  bridge: Bridge;
  groupId?: number;
  userUid?: string;
}

function makeTextElem(text: string): ProtoElem {
  return {
    text: { str: text } as any,
  };
}

function makeFaceElem(faceId: number): ProtoElem {
  return {
    face: { index: faceId } as any,
  };
}

function makeMentionElem(element: MessageElement): ProtoElem {
  const mentionAll = element.uid === 'all' || element.targetUin === 0;

  const extra = protoEncode({
    type: mentionAll ? 1 : 2,
    uin: mentionAll ? 0 : (element.targetUin ?? 0),
    field5: 0,
    uid: mentionAll ? 'all' : (element.uid ?? ''),
  }, MentionExtraSendSchema);

  return {
    text: {
      str: element.text || (mentionAll ? '@全体成员 ' : `@${element.targetUin} `),
      pbReserve: extra,
    } as any,
  };
}

function makeReplyElem(element: MessageElement): ProtoElem {
  const seq = element.replySeq! & 0xFFFFFFFF;
  
  const srcMsg: any = {
    origSeqs: [seq],
  };
  
  // Add additional fields if available for better reply display
  if (element.replySenderUin) {
    srcMsg.senderUin = BigInt(element.replySenderUin);
  }
  if (element.replyTime) {
    srcMsg.time = element.replyTime;
  }
  
  return { srcMsg };
}

function makeJsonElem(element: MessageElement): ProtoElem {
  const content = element.text ?? '';
  const payload = new Uint8Array(content.length + 1);
  payload[0] = 0x00;
  const encoded = new TextEncoder().encode(content);
  payload.set(encoded, 1);

  return {
    richMsg: {
      serviceId: 1,
      template1: payload,
    } as any,
  };
}

function makeXmlElem(element: MessageElement): ProtoElem {
  const content = element.text ?? '';
  const payload = new Uint8Array(content.length + 1);
  payload[0] = 0x00;
  const encoded = new TextEncoder().encode(content);
  payload.set(encoded, 1);

  return {
    richMsg: {
      serviceId: element.subType === 0 ? 35 : (element.subType ?? 35),
      template1: payload,
    } as any,
  };
}

function makeMarkdownElem(element: MessageElement): ProtoElem {
  const data = protoEncode({ content: element.text ?? '' }, MarkdownDataSchema);

  return {
    commonElem: {
      serviceType: 45,
      pbElem: data,
      businessType: 1,
    } as any,
  };
}

function makeForwardElem(element: MessageElement): ProtoElem {
  const resId = (element.resId ?? '').trim();
  if (!resId) {
    throw new Error('forward resId is required');
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?><msg templateID="1" action="viewMultiMsg" serviceID="35" brief="[聊天记录]" m_resid="${resId}" m_fileName="${resId}" actionData="${resId}" tSum="2" sourceMsgId="0" flag="3" adverSign="0" multiMsgFlag="0"><item layout="1"><title size="34" color="#000000">聊天记录</title><title size="26" color="#777777">查看转发消息</title><summary size="26" color="#808080">查看转发消息</summary></item><source name="" icon="" action="" appid="-1"/></msg>`;
  const encodedXml = new TextEncoder().encode(xml);
  const payload = new Uint8Array(encodedXml.length + 1);
  payload[0] = 0x00;
  payload.set(encodedXml, 1);

  return {
    richMsg: {
      serviceId: 35,
      template1: payload,
    } as any,
  };
}

async function makeImageElem(ctx: SendContext, element: MessageElement): Promise<ProtoElem> {
  const isGroup = ctx.groupId !== undefined;
  const targetIdOrUid = isGroup ? ctx.groupId! : (ctx.userUid ?? '');
  if (!isGroup && !targetIdOrUid) {
    throw new Error('private image target uid is missing');
  }

  const msgInfo = await uploadImageMsgInfo(ctx.bridge, isGroup, targetIdOrUid, element);

  return {
    commonElem: {
      serviceType: 48,
      pbElem: msgInfo,
      businessType: isGroup ? 20 : 10,
    } as any,
  };
}

/**
 * Build proto Elem objects from an array of MessageElements.
 * Supports: text, face, at, reply, json, xml, markdown, image.
 * Image elements trigger highway upload via the SendContext.
 */
export async function buildSendElems(elements: MessageElement[], ctx?: SendContext): Promise<ProtoElem[]> {
  const result: ProtoElem[] = [];

  for (const elem of elements) {
    switch (elem.type) {
      case 'text':
        if (elem.text) result.push(makeTextElem(elem.text));
        break;

      case 'face':
        if (elem.faceId !== undefined) result.push(makeFaceElem(elem.faceId));
        break;

      case 'at':
        result.push(makeMentionElem(elem));
        break;

      case 'reply':
        if (elem.replySeq) result.push(makeReplyElem(elem));
        break;

      case 'json':
        if (elem.text) result.push(makeJsonElem(elem));
        break;

      case 'xml':
        if (elem.text) result.push(makeXmlElem(elem));
        break;

      case 'markdown':
        if (elem.text) result.push(makeMarkdownElem(elem));
        break;

      case 'image':
        if (ctx) {
          result.push(await makeImageElem(ctx, elem));
        } else {
          console.warn('[ElemBuilder] image send requires SendContext');
        }
        break;

      case 'forward':
        if (elem.resId) result.push(makeForwardElem(elem));
        break;

      case 'record':
      case 'video':
        console.warn(`[ElemBuilder] ${elem.type} send not yet implemented`);
        break;

      default:
        console.warn(`[ElemBuilder] unsupported element type for send: ${elem.type}`);
        break;
    }
  }

  return result;
}
