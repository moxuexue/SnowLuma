// MsgPush packet handler — parses trpc.msg.olpush.OlPushService.MsgPush
// into bridge events. Port of src/bridge/src/handlers/msg_push_handler.h/.cpp

import { inflateSync } from 'zlib';
import { protoDecode } from '../../protobuf/decode';
import { WireMessage } from '../../protobuf/wire';
import { PushMsgSchema } from '../proto/message';
import {
  MentionExtraSchema, QFaceExtraSchema, QSmallFaceExtraSchema,
  MsgInfoSchema, GroupFileExtraSchema, NotOnlineImageSchema,
} from '../proto/element';
import { FileExtraSchema } from '../proto/message';
import {
  GroupChangeSchema, GroupAdminSchema, GroupJoinSchema,
  GroupInvitationSchema, GroupInviteSchema,
  FriendRequestSchema, FriendRecallSchema,
  GroupMuteSchema, NotifyMessageBodySchema,
  GeneralGrayTipInfoSchema, OperatorInfoSchema,
} from '../proto/notify';
import type { QQInfo } from '../qq-info';
import type { PacketInfo } from '../../protocol/types';
import type {
  QQEventVariant, MessageElement,
  FriendMessage, GroupMessage, TempMessage,
  GroupMemberJoin, GroupMemberLeave, GroupMuteEvent, GroupAdminEvent,
  FriendRecall, GroupRecallEvent, FriendRequestEvent, GroupInviteEvent,
  FriendPokeEvent, GroupPokeEvent, GroupEssenceEvent,
} from '../events';
import type { ProtoDecoded, ProtoSchema } from '../../protobuf/decode';

// --- PkgType enum ---
const enum PkgType {
  ForwardFakePrivateMessage = 9,
  PrivateMessage = 166,
  GroupMessage = 82,
  TempMessage = 141,
  Event0x210 = 528,
  Event0x2DC = 732,
  PrivateRecordMessage = 208,
  PrivateFileMessage = 529,
  GroupRequestInvitationNotice = 525,
  GroupRequestJoinNotice = 84,
  GroupInviteNotice = 87,
  GroupAdminChangedNotice = 44,
  GroupMemberIncreaseNotice = 33,
  GroupMemberDecreaseNotice = 34,
}

const enum Event0x2DCSubType {
  GroupMuteNotice = 12,
  GroupRecallNotice = 17,
  GroupGreyTipNotice = 20,
  GroupEssenceNotice = 21,
}

const enum Event0x210SubType {
  FriendRequestNotice = 35,
  FriendRecallNotice = 138,
  FriendPokeNotice = 290,
}

// --- Helpers ---

function makeImageUrl(origUrl: string): string {
  if (!origUrl) return '';
  if (origUrl.includes('rkey')) return 'https://multimedia.nt.qq.com.cn' + origUrl;
  return 'http://gchat.qpic.cn' + origUrl;
}

const HEX_CHARS = '0123456789ABCDEF';
function bytesToHex(data: Uint8Array): string {
  let r = '';
  for (const b of data) { r += HEX_CHARS[b >> 4]; r += HEX_CHARS[b & 0x0f]; }
  return r;
}

function decompressData(data: Uint8Array): string {
  if (!data || data.length === 0) return '';
  if (data[0] === 0x01 && data.length > 1) {
    try {
      const inflated = inflateSync(Buffer.from(data.subarray(1)));
      return inflated.toString('utf8');
    } catch { return ''; }
  }
  if (data[0] === 0x00 && data.length > 1) {
    return Buffer.from(data.subarray(1)).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function isNumericUin(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

function parseU64OrZero(value: string): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

function resolveUidToUin(qqInfo: QQInfo, groupId: number, uid: string, fallback = 0): number {
  if (!uid) return fallback;
  if (isNumericUin(uid)) {
    const n = parseInt(uid, 10);
    if (!isNaN(n)) return n;
  }
  if (groupId) {
    const uin = qqInfo.resolveGroupMemberUid(groupId, uid);
    if (uin !== null) return uin;
  }
  const uin = qqInfo.resolveUid(uid);
  if (uin !== null) return uin;
  return fallback;
}

function decodeOperatorUid(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) return '';
  const info = protoDecode(bytes, OperatorInfoSchema);
  if (info?.operatorField?.uid) return info.operatorField.uid;
  return Buffer.from(bytes).toString('utf8');
}

function buildTemplateMap(params: Array<{name?: string; value?: string}>): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of params) {
    if (p.name !== undefined) map.set(p.name, p.value ?? '');
  }
  return map;
}

function findTemplateValue(map: Map<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = map.get(k);
    if (v) return v;
  }
  return '';
}

function unwrapGroupNotifyPayload(content: Uint8Array): Uint8Array | null {
  if (content.length <= 7) return null;
  const lenBe = (content[5] << 8) | content[6];
  const lenLe = content[5] | (content[6] << 8);
  if (7 + lenBe <= content.length) return content.subarray(7, 7 + lenBe);
  if (7 + lenLe <= content.length) return content.subarray(7, 7 + lenLe);
  return content.subarray(7);
}

// --- Element conversion ---

type ElemDecoded = ProtoDecoded<typeof import('../proto/element').ElemSchema>;

function convertElements(elems: ElemDecoded[]): MessageElement[] {
  const result: MessageElement[] = [];
  let skipNext = false;

  for (const elem of elems) {
    if (skipNext) { skipNext = false; continue; }

    // Reply / quote
    if (elem.srcMsg?.origSeqs && elem.srcMsg.origSeqs.length > 0) {
      result.push({ type: 'reply', replySeq: elem.srcMsg.origSeqs[0] });
    }

    // Text (with possible @ detection)
    if (elem.text) {
      const t = elem.text;
      let mention: ProtoDecoded<typeof MentionExtraSchema> | null = null;
      if (t.pbReserve && t.pbReserve.length > 0) {
        mention = protoDecode(t.pbReserve, MentionExtraSchema);
      }
      const hasAttr6 = t.attr6Buf && t.attr6Buf.length > 11;
      const hasMention = mention && (mention.type === 1 || mention.type === 2);

      if (hasAttr6 || hasMention) {
        const me: MessageElement = { type: 'at', text: t.str ?? '' };
        if (hasAttr6) {
          const buf = t.attr6Buf!;
          me.targetUin = ((buf[7] << 24) | (buf[8] << 16) | (buf[9] << 8) | buf[10]) >>> 0;
        }
        if (hasMention && mention) {
          me.uid = mention.uid ?? '';
          if (!me.targetUin) me.targetUin = mention.uin ?? 0;
        }
        result.push(me);
      } else {
        const text = t.str ?? '';
        if (text) result.push({ type: 'text', text });
      }
    }

    // Face
    if (elem.face) {
      result.push({ type: 'face', faceId: elem.face.index ?? 0 });
    }

    // MarketFace
    if (elem.marketFace) {
      result.push({
        type: 'mface',
        text: elem.marketFace.faceName ?? '',
        faceId: elem.marketFace.tabId ?? 0,
        subType: elem.marketFace.subType ?? 0,
      });
    }

    // NotOnlineImage (C2C image)
    if (elem.notOnlineImage) {
      const img = elem.notOnlineImage;
      if (img.picMd5 && img.picMd5.length > 0) {
        const urlPath = img.origUrl || img.bigUrl || '';
        result.push({
          type: 'image',
          imageUrl: makeImageUrl(urlPath),
          fileId: img.filePath ?? '',
          fileSize: img.fileLen ?? 0,
          width: img.picWidth ?? 0,
          height: img.picHeight ?? 0,
          subType: img.pbRes?.subType ?? 0,
          summary: img.pbRes?.summary ?? '[image]',
        });
      }
    }

    // CustomFace (group image)
    if (elem.customFace) {
      const img = elem.customFace;
      if (img.md5 && img.md5.length > 0) {
        result.push({
          type: 'image',
          imageUrl: makeImageUrl(img.origUrl ?? ''),
          fileId: img.filePath ?? '',
          fileSize: img.size ?? 0,
          width: img.width ?? 0,
          height: img.height ?? 0,
          subType: img.pbRes?.subType ?? 0,
          summary: img.pbRes?.summary ?? '[image]',
        });
      }
    }

    // VideoFile
    if (elem.videoFile) {
      const v = elem.videoFile;
      result.push({
        type: 'video',
        fileId: v.fileUuid ?? '',
        fileName: v.fileName ?? '',
        fileSize: v.fileSize ?? 0,
        duration: v.fileTime ?? 0,
        fileHash: v.fileMd5 && v.fileMd5.length > 0 ? bytesToHex(v.fileMd5) : '',
        mediaNode: {
          fileUuid: v.fileUuid ?? '',
          info: {
            fileSize: v.fileSize ?? 0,
            fileHash: v.fileMd5 && v.fileMd5.length > 0 ? bytesToHex(v.fileMd5) : '',
            fileName: v.fileName ?? '',
            width: v.fileWidth ?? 0,
            height: v.fileHeight ?? 0,
            time: v.fileTime ?? 0,
            type: {
              type: 2,
              videoFormat: v.fileFormat ?? 0,
            },
          },
        },
      });
    }

    // GroupFile
    if (elem.groupFile) {
      const f = elem.groupFile;
      result.push({
        type: 'file',
        fileId: f.fileId ?? '',
        fileName: f.filename ?? '',
        fileSize: f.fileSize !== undefined ? Number(f.fileSize) : 0,
      });
    }

    // TransElem type=24 (group file via transport)
    if (elem.transElem) {
      const te = elem.transElem;
      if ((te.elemType ?? 0) === 24 && te.elemValue && te.elemValue.length > 3) {
        const val = te.elemValue;
        const len = (val[1] << 8) | val[2];
        if (val.length >= 3 + len) {
          const extra = protoDecode(val.subarray(3, 3 + len), GroupFileExtraSchema);
          if (extra?.inner?.info) {
            const info = extra.inner.info;
            result.push({
              type: 'file',
              fileName: info.fileName ?? '',
              fileSize: info.fileSize !== undefined ? Number(info.fileSize) : 0,
              fileId: info.fileId ?? '',
            });
          }
        }
      }
    }

    // RichMsg
    if (elem.richMsg) {
      const rm = elem.richMsg;
      if (rm.template1 && rm.template1.length > 0) {
        const content = decompressData(rm.template1);
        if (content) {
          const svcId = rm.serviceId ?? 0;
          if (svcId === 35) {
            const pos = content.indexOf('m_resid="');
            if (pos !== -1) {
              const start = pos + 9;
              const end = content.indexOf('"', start);
              if (end !== -1) {
                result.push({ type: 'forward', resId: content.substring(start, end) });
                continue;
              }
            }
            result.push({ type: 'xml', text: content, subType: svcId });
          } else if (svcId === 1) {
            result.push({ type: 'json', text: content });
          } else {
            result.push({ type: 'xml', text: content, subType: svcId });
          }
        }
      }
    }

    // LightApp
    if (elem.lightApp) {
      const la = elem.lightApp;
      if (la.data && la.data.length > 0) {
        const content = decompressData(la.data);
        if (content) result.push({ type: 'json', text: content });
      }
    }

    // CommonElem
    if (elem.commonElem) {
      const ce = elem.commonElem;
      const svcType = ce.serviceType ?? 0;
      const bizType = ce.businessType ?? 0;

      if (svcType === 2) {
        // Poke
        result.push({ type: 'poke', subType: bizType });
      } else if (svcType === 3 && ce.pbElem && ce.pbElem.length > 1) {
        // Flash image
        const pb = ce.pbElem;
        let pos = 1;
        let length = 0, shift = 0;
        while (pos < pb.length) {
          const b = pb[pos++];
          length |= (b & 0x7f) << shift;
          shift += 7;
          if ((b & 0x80) === 0) break;
        }
        if (pos + length <= pb.length) {
          const img = protoDecode(pb.subarray(pos, pos + length), NotOnlineImageSchema);
          if (img) {
            const me: MessageElement = {
              type: 'image', fileId: img.filePath ?? '',
              fileSize: img.fileLen ?? 0, width: img.picWidth ?? 0,
              height: img.picHeight ?? 0, flash: true, summary: '[flash image]',
            };
            if (img.pbRes) me.subType = img.pbRes.subType ?? 0;
            if (img.picMd5 && img.picMd5.length > 0) {
              me.imageUrl = 'http://gchat.qpic.cn/gchatpic_new/0/0-0-' + bytesToHex(img.picMd5) + '/0';
            }
            result.push(me);
          }
        }
        skipNext = true;
      } else if (ce.pbElem && (svcType === 48 || bizType === 10 || bizType === 20 || bizType === 11 || bizType === 21 || bizType === 12 || bizType === 22)) {
        // NTQQ new protocol image/record/video
        const info = protoDecode(ce.pbElem, MsgInfoSchema);
        if (info?.msgInfoBody && info.msgInfoBody.length > 0) {
          const body = info.msgInfoBody[0];
          if (body.index?.info) {
            const idx = body.index;
            const fi = idx.info!;

            if (bizType === 10 || bizType === 20) {
              // Image
              let url = '';
              if (body.picture) {
                const domain = body.picture.domain ?? 'multimedia.nt.qq.com.cn';
                const path = body.picture.urlPath ?? '';
                if (path) {
                  url = 'https://' + domain + path;
                  if (body.picture.ext?.originalParameter) {
                    url += body.picture.ext.originalParameter;
                  }
                }
              }
              const me: MessageElement = {
                type: 'image', fileId: fi.fileName ?? '',
                fileSize: fi.fileSize ?? 0, width: fi.width ?? 0,
                height: fi.height ?? 0, imageUrl: url,
              };
              if (info.extBizInfo?.pic) {
                me.subType = info.extBizInfo.pic.bizType ?? 0;
                me.summary = info.extBizInfo.pic.textSummary || '[image]';
              }
              result.push(me);
            } else if (bizType === 12 || bizType === 22) {
              // Record
              result.push({
                type: 'record', fileName: fi.fileName ?? '',
                fileId: idx.fileUuid ?? '', duration: fi.time ?? 0,
                fileHash: fi.fileHash ?? '',
                mediaNode: {
                  fileUuid: idx.fileUuid,
                  storeId: idx.storeId,
                  uploadTime: idx.uploadTime,
                  ttl: idx.ttl,
                  subType: idx.subType,
                  info: {
                    fileSize: fi.fileSize,
                    fileHash: fi.fileHash,
                    fileSha1: fi.fileSha1,
                    fileName: fi.fileName,
                    width: fi.width,
                    height: fi.height,
                    time: fi.time,
                    original: fi.original,
                    type: {
                      type: fi.type?.type,
                      picFormat: fi.type?.picFormat,
                      videoFormat: fi.type?.videoFormat,
                      voiceFormat: fi.type?.voiceFormat,
                    },
                  },
                },
              });
            } else if (bizType === 11 || bizType === 21) {
              // Video
              result.push({
                type: 'video', fileName: fi.fileName ?? '',
                fileId: idx.fileUuid ?? '', fileSize: fi.fileSize ?? 0,
                duration: fi.time ?? 0,
                fileHash: fi.fileHash ?? '',
                mediaNode: {
                  fileUuid: idx.fileUuid,
                  storeId: idx.storeId,
                  uploadTime: idx.uploadTime,
                  ttl: idx.ttl,
                  subType: idx.subType,
                  info: {
                    fileSize: fi.fileSize,
                    fileHash: fi.fileHash,
                    fileSha1: fi.fileSha1,
                    fileName: fi.fileName,
                    width: fi.width,
                    height: fi.height,
                    time: fi.time,
                    original: fi.original,
                    type: {
                      type: fi.type?.type,
                      picFormat: fi.type?.picFormat,
                      videoFormat: fi.type?.videoFormat,
                      voiceFormat: fi.type?.voiceFormat,
                    },
                  },
                },
              });
            }
          }
        }
      } else if (svcType === 33 && ce.pbElem) {
        // Small face
        const extra = protoDecode(ce.pbElem, QSmallFaceExtraSchema);
        if (extra) result.push({ type: 'face', faceId: extra.faceId ?? 0 });
      } else if (svcType === 37 && ce.pbElem) {
        // Big face
        const extra = protoDecode(ce.pbElem, QFaceExtraSchema);
        if (extra?.qsid !== undefined) result.push({ type: 'face', faceId: extra.qsid });
        skipNext = true;
      }
    }
  }

  return result;
}

function extractRichtextExtras(
  rt: ProtoDecoded<typeof import('../proto/message').RichTextSchema>,
  elements: MessageElement[],
  isGroup = false
): void {
  // Ptt (voice)
  if (rt.ptt) {
    const p = rt.ptt;
    const me: MessageElement = {
      type: 'record', fileName: p.fileName ?? '',
      fileSize: p.fileSize ?? 0, duration: p.time ?? 0,
      fileHash: p.fileMd5 && p.fileMd5.length > 0 ? bytesToHex(p.fileMd5) : '',
    };
    if (isGroup && (p.fileId ?? 0n) !== 0n) {
      me.fileId = p.groupFileKey ?? '';
    } else {
      if (p.fileUuid && p.fileUuid.length > 0) {
        me.fileId = Buffer.from(p.fileUuid).toString('utf8');
      }
    }
    me.mediaNode = {
      fileUuid: me.fileId ?? '',
      info: {
        fileSize: p.fileSize ?? 0,
        fileHash: p.fileMd5 && p.fileMd5.length > 0 ? bytesToHex(p.fileMd5) : '',
        fileName: p.fileName ?? '',
        time: p.time ?? 0,
        type: {
          type: 3,
          voiceFormat: p.format ?? 0,
        },
      },
    };
    elements.push(me);
  }

  // NotOnlineFile (C2C file)
  if (rt.notOnlineFile) {
    const f = rt.notOnlineFile;
    elements.push({
      type: 'file', fileId: f.fileUuid ?? '',
      fileName: f.fileName ?? '',
      fileSize: f.fileSize !== undefined ? Number(f.fileSize) : 0,
      fileHash: f.fileHash ?? '',
    });
  }
}

function extractMsgContent(msgContent: Uint8Array, elements: MessageElement[]): void {
  const extra = protoDecode(msgContent, FileExtraSchema);
  if (!extra?.file) return;
  const f = extra.file;
  if (f.fileSize !== undefined && f.fileName && f.fileMd5 && f.fileUuid && f.fileHash) {
    elements.push({
      type: 'file', fileName: f.fileName, fileId: f.fileUuid,
      fileSize: f.fileSize !== undefined ? Number(f.fileSize) : 0,
      fileHash: f.fileHash,
    });
  }
}

// --- Main handler ---

export const MSG_PUSH_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

export function parseMsgPush(pkt: PacketInfo, qqInfo: QQInfo): QQEventVariant[] {
  if (pkt.body.length === 0) return [];

  const push = protoDecode(Buffer.from(pkt.body), PushMsgSchema);
  if (!push?.message) return [];

  const msg = push.message;
  if (!msg.contentHead) return [];

  const head = msg.contentHead;
  const msgType = head.msgType ?? 0;
  const subType = head.subType ?? 0;
  const sequence = head.sequence ?? 0;
  const timestamp = head.timestamp ?? 0;
  const msgId = head.msgId ?? 0;

  let fromUin = 0;
  let fromUid = '';
  if (msg.responseHead) {
    fromUin = msg.responseHead.fromUin ?? 0;
    fromUid = msg.responseHead.fromUid ?? '';
  }

  let selfUin = 0;
  if (pkt.uin) {
    const n = parseInt(pkt.uin, 10);
    if (!isNaN(n)) selfUin = n;
  }

  const content = (msg.body?.msgContent) ? msg.body.msgContent : new Uint8Array(0);

  const buildElements = (isGroup: boolean): MessageElement[] => {
    const elements: MessageElement[] = [];
    if (msg.body?.richText) {
      const rt = msg.body.richText;
      if (rt.elems) elements.push(...convertElements(rt.elems as ElemDecoded[]));
      extractRichtextExtras(rt, elements, isGroup);
    }
    if (msg.body?.msgContent && msg.body.msgContent.length > 0) {
      extractMsgContent(msg.body.msgContent, elements);
    }
    return elements;
  };

  // --- Switch on msgType ---

  switch (msgType as PkgType) {
    case PkgType.GroupMemberIncreaseNotice: {
      const change = protoDecode(content, GroupChangeSchema);
      if (!change) return [];
      const groupId = change.groupUin ?? 0;
      const userUid = change.memberUid ?? '';
      const operatorUid = decodeOperatorUid(change.operatorBytes ?? new Uint8Array(0));
      const ev: GroupMemberJoin = {
        kind: 'group_member_join', time: timestamp, selfUin,
        groupId,
        userUin: resolveUidToUin(qqInfo, groupId, userUid, 0),
        operatorUin: resolveUidToUin(qqInfo, groupId, operatorUid, 0),
        userUid,
        operatorUid,
      };
      return [ev];
    }

    case PkgType.GroupMemberDecreaseNotice: {
      const change = protoDecode(content, GroupChangeSchema);
      if (!change) return [];
      const dt = change.decreaseType ?? 0;
      const groupId = change.groupUin ?? 0;
      const userUid = change.memberUid ?? '';
      const operatorUid = decodeOperatorUid(change.operatorBytes ?? new Uint8Array(0));
      const ev: GroupMemberLeave = {
        kind: 'group_member_leave', time: timestamp, selfUin,
        groupId,
        userUin: resolveUidToUin(qqInfo, groupId, userUid, 0),
        operatorUin: resolveUidToUin(qqInfo, groupId, operatorUid, 0),
        userUid,
        operatorUid,
        isKick: dt !== 0 && dt !== 130,
      };
      return [ev];
    }

    case PkgType.GroupAdminChangedNotice: {
      const admin = protoDecode(content, GroupAdminSchema);
      if (!admin?.body) return [];
      const extra = admin.body.extraEnable ?? admin.body.extraDisable;
      if (!extra) return [];
      const ev: GroupAdminEvent = {
        kind: 'group_admin', time: timestamp, selfUin,
        groupId: admin.groupUin ?? 0,
        userUin: resolveUidToUin(qqInfo, admin.groupUin ?? 0, extra.adminUid ?? '', fromUin),
        set: admin.body.extraEnable !== undefined,
      };
      return [ev];
    }

    case PkgType.GroupRequestJoinNotice: {
      const join = protoDecode(content, GroupJoinSchema);
      if (!join) return [];
      const ev: GroupInviteEvent = {
        kind: 'group_invite', time: timestamp, selfUin,
        groupId: join.groupUin ?? 0,
        fromUin: resolveUidToUin(qqInfo, join.groupUin ?? 0, join.targetUid ?? '', fromUin),
        fromUid: join.targetUid ?? '',
        subType: 'add', message: '',
        flag: 'add:' + (join.groupUin ?? 0) + ':' + (join.targetUid ?? ''),
      };
      return [ev];
    }

    case PkgType.GroupRequestInvitationNotice: {
      const invitation = protoDecode(content, GroupInvitationSchema);
      if (!invitation?.info?.inner) return [];
      const inner = invitation.info.inner;
      const ev: GroupInviteEvent = {
        kind: 'group_invite', time: timestamp, selfUin,
        groupId: inner.groupUin ?? 0,
        fromUin: resolveUidToUin(qqInfo, inner.groupUin ?? 0, inner.invitorUid ?? '', fromUin),
        fromUid: inner.invitorUid ?? '',
        subType: 'invite', message: '',
        flag: 'invite:' + (inner.groupUin ?? 0) + ':' + (inner.invitorUid ?? ''),
      };
      return [ev];
    }

    case PkgType.GroupInviteNotice: {
      const invite = protoDecode(content, GroupInviteSchema);
      if (!invite) return [];
      const ev: GroupInviteEvent = {
        kind: 'group_invite', time: timestamp, selfUin,
        groupId: invite.groupUin ?? 0,
        fromUin: resolveUidToUin(qqInfo, invite.groupUin ?? 0, invite.invitorUid ?? '', fromUin),
        fromUid: invite.invitorUid ?? '',
        subType: 'invite', message: '',
        flag: 'invite:' + (invite.groupUin ?? 0) + ':' + (invite.invitorUid ?? ''),
      };
      return [ev];
    }

    case PkgType.Event0x210: {
      switch (subType as Event0x210SubType) {
        case Event0x210SubType.FriendRequestNotice: {
          const request = protoDecode(content, FriendRequestSchema);
          if (!request?.info) return [];
          const sourceUid = request.info.newSource || request.info.sourceUid || '';
          const ev: FriendRequestEvent = {
            kind: 'friend_request', time: timestamp, selfUin,
            fromUin: resolveUidToUin(qqInfo, 0, sourceUid, fromUin),
            fromUid: sourceUid,
            message: request.info.message ?? '', flag: sourceUid,
          };
          return [ev];
        }
        case Event0x210SubType.FriendRecallNotice: {
          const recall = protoDecode(content, FriendRecallSchema);
          if (!recall?.info) return [];
          const ev: FriendRecall = {
            kind: 'friend_recall', time: recall.info.time ?? timestamp, selfUin,
            userUin: resolveUidToUin(qqInfo, 0, recall.info.fromUid ?? '', fromUin),
            msgSeq: recall.info.clientSequence ?? 0,
          };
          return [ev];
        }
        case Event0x210SubType.FriendPokeNotice: {
          const grayTip = protoDecode(content, GeneralGrayTipInfoSchema);
          if (!grayTip || (grayTip.busiType ?? 0n) !== 12n) return [];
          const templates = buildTemplateMap(grayTip.msgTemplParam ?? []);
          const actor = findTemplateValue(templates, 'uin_str1');
          const target = findTemplateValue(templates, 'uin_str2');
          const ev: FriendPokeEvent = {
            kind: 'friend_poke', time: timestamp, selfUin,
            userUin: resolveUidToUin(qqInfo, 0, actor, parseU64OrZero(actor)),
            targetUin: resolveUidToUin(qqInfo, 0, target, parseU64OrZero(target)),
            action: findTemplateValue(templates, 'action_str', 'alt_str1'),
            suffix: findTemplateValue(templates, 'suffix_str'),
            actionImgUrl: findTemplateValue(templates, 'action_img_url'),
          };
          return [ev];
        }
      }
      break;
    }

    case PkgType.Event0x2DC: {
      switch (subType as Event0x2DCSubType) {
        case Event0x2DCSubType.GroupMuteNotice: {
          const mute = protoDecode(content, GroupMuteSchema);
          if (!mute?.data?.state) return [];
          const duration = mute.data.state.duration ?? 0;
          const ev: GroupMuteEvent = {
            kind: 'group_mute', time: mute.data.timestamp ?? timestamp, selfUin,
            groupId: mute.groupUin ?? 0,
            operatorUin: resolveUidToUin(qqInfo, mute.groupUin ?? 0, mute.operatorUid ?? '', fromUin),
            userUin: resolveUidToUin(qqInfo, mute.groupUin ?? 0, mute.data.state.targetUid ?? '', 0),
            duration: duration === 0xFFFFFFFF ? 0x7FFFFFFF : duration,
          };
          return [ev];
        }
        case Event0x2DCSubType.GroupRecallNotice: {
          const payload = unwrapGroupNotifyPayload(content);
          if (!payload) return [];
          const notify = protoDecode(payload, NotifyMessageBodySchema);
          if (!notify?.recall?.recallMessages || notify.recall.recallMessages.length === 0) return [];
          const recalled = notify.recall.recallMessages[0];
          const ev: GroupRecallEvent = {
            kind: 'group_recall', time: recalled.time ?? timestamp, selfUin,
            groupId: notify.groupUin ?? 0,
            operatorUin: resolveUidToUin(qqInfo, notify.groupUin ?? 0,
              notify.recall.operatorUid || notify.operatorUid || '', fromUin),
            authorUin: resolveUidToUin(qqInfo, notify.groupUin ?? 0, recalled.authorUid ?? '', fromUin),
            msgSeq: recalled.sequence ?? 0,
          };
          return [ev];
        }
        case Event0x2DCSubType.GroupGreyTipNotice: {
          const payload = unwrapGroupNotifyPayload(content);
          if (!payload) return [];
          const notify = protoDecode(payload, NotifyMessageBodySchema);
          if (!notify?.generalGrayTip || (notify.generalGrayTip.busiType ?? 0n) !== 12n) return [];
          const templates = buildTemplateMap(notify.generalGrayTip.msgTemplParam ?? []);
          const actor = findTemplateValue(templates, 'uin_str1');
          const target = findTemplateValue(templates, 'uin_str2');
          const ev: GroupPokeEvent = {
            kind: 'group_poke', time: timestamp, selfUin,
            groupId: notify.groupUin ?? 0,
            userUin: resolveUidToUin(qqInfo, notify.groupUin ?? 0, actor, parseU64OrZero(actor)),
            targetUin: resolveUidToUin(qqInfo, notify.groupUin ?? 0, target, parseU64OrZero(target)),
            action: findTemplateValue(templates, 'action_str', 'alt_str1'),
            suffix: findTemplateValue(templates, 'suffix_str'),
            actionImgUrl: findTemplateValue(templates, 'action_img_url'),
          };
          return [ev];
        }
        case Event0x2DCSubType.GroupEssenceNotice: {
          const payload = unwrapGroupNotifyPayload(content);
          if (!payload) return [];
          const notify = protoDecode(payload, NotifyMessageBodySchema);
          if (!notify?.essenceMessage) return [];
          const essence = notify.essenceMessage;
          const setFlag = essence.setFlag ?? essence.setFlag2 ?? 0;
          const ev: GroupEssenceEvent = {
            kind: 'group_essence', time: essence.timestamp ?? timestamp, selfUin,
            groupId: essence.groupUin ?? notify.groupUin ?? 0,
            senderUin: essence.memberUin ?? 0,
            operatorUin: essence.operatorUin ?? fromUin,
            msgSeq: essence.msgSequence ?? essence.msgSequence2 ?? notify.msgSequence ?? 0,
            random: essence.random ?? 0,
            set: setFlag === 1,
          };
          return [ev];
        }
      }
      break;
    }
  }

  // --- Message types ---

  if (msgType === PkgType.GroupMessage) {
    const ev: GroupMessage = {
      kind: 'group_message', time: timestamp, selfUin,
      senderUin: fromUin, msgSeq: sequence,
      msgId: msgId & 0x7FFFFFFF,
      elements: buildElements(true),
      groupId: 0, senderNick: '', senderCard: '', senderRole: '',
    };
    if (msg.responseHead?.grp) {
      ev.groupId = msg.responseHead.grp.groupUin ?? 0;
      ev.senderNick = msg.responseHead.grp.memberName ?? '';
    }
    const member = qqInfo.findGroupMember(ev.groupId, fromUin);
    if (member) {
      if (!ev.senderNick) ev.senderNick = member.nickname;
      ev.senderCard = member.card;
      ev.senderRole = member.role;
    }
    return [ev];
  }

  if (msgType === PkgType.TempMessage) {
    const ev: TempMessage = {
      kind: 'temp_message', time: timestamp, selfUin,
      senderUin: fromUin, msgSeq: sequence,
      elements: buildElements(false),
      groupId: 0, senderNick: '',
    };
    if (msg.responseHead?.grp) {
      ev.groupId = msg.responseHead.grp.groupUin ?? 0;
      ev.senderNick = msg.responseHead.grp.memberName ?? '';
    }
    if (!ev.senderNick) {
      const friend = qqInfo.findFriend(fromUin);
      if (friend) ev.senderNick = friend.nickname;
    }
    return [ev];
  }

  if (msgType === PkgType.PrivateMessage ||
      msgType === PkgType.ForwardFakePrivateMessage ||
      msgType === PkgType.PrivateRecordMessage ||
      msgType === PkgType.PrivateFileMessage) {
    const ev: FriendMessage = {
      kind: 'friend_message', time: timestamp, selfUin,
      senderUin: fromUin, msgSeq: sequence,
      msgId: msgId & 0x7FFFFFFF,
      elements: buildElements(false),
      senderNick: '',
    };
    if (msg.responseHead?.forward?.friendName) {
      ev.senderNick = msg.responseHead.forward.friendName;
    }
    const friend = qqInfo.findFriend(fromUin);
    if (friend && !ev.senderNick) ev.senderNick = friend.nickname;
    return [ev];
  }

 // const preview = bytesToHex(content.subarray(0, Math.min(content.length, 48)));
  return [];
}
