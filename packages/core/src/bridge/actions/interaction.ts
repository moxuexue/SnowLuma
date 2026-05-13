// Lightweight social-interaction actions: poke, like, emoji reaction,
// and the related read-side "who reacted with X" query. None of these
// edit message content — they're purely social signals.

import type { Bridge } from '../bridge';
import { sendOidbAndCheck, sendOidbAndDecode } from '../bridge-oidb';
import {
  Oidb0x9083ReqSchema,
  Oidb0x9083RespSchema,
  OidbGroupReactionSchema,
  OidbLikeSchema,
  OidbPokeSchema,
} from '../proto/oidb-action';

export async function sendPoke(bridge: Bridge, isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0xed3_1', 0xED3, 1,
    {
      uin: targetUin ?? peerUin,
      groupUin: isGroup ? peerUin : 0,
      friendUin: isGroup ? 0 : peerUin,
      ext: 0,
    }, OidbPokeSchema);
}

export async function sendLike(bridge: Bridge, userId: number, count: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x7e5_104', 0x7E5, 104,
    { targetUin: userId, count }, OidbLikeSchema);
}

export async function setGroupReaction(bridge: Bridge, groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
  const subCmd = isSet ? 1 : 2;
  const cmd = isSet ? 'OidbSvcTrpcTcp.0x9082_1' : 'OidbSvcTrpcTcp.0x9082_2';
  await sendOidbAndCheck(bridge, cmd, 0x9082, subCmd,
    { groupUin: groupId, sequence, code }, OidbGroupReactionSchema);
}

export async function getEmojiLikes(
  bridge: Bridge,
  groupId: number,
  sequence: number,
  emojiId: string,
  emojiType: number = 1,
  count: number = 10,
  cookie: string = '',
): Promise<{ users: Array<{ uin: number }>, cookie: string, isLast: boolean }> {
  const req = {
    groupId: BigInt(groupId),
    sequence,
    emojiType,
    emojiId,
    cookie: cookie ? Buffer.from(cookie, 'base64') : new Uint8Array(0),
    field7: 0,
    count,
    field12: 1,
  };
  const resp = await sendOidbAndDecode<any>(bridge, 'OidbSvcTrpcTcp.0x9083_1', 0x9083, 1, req, Oidb0x9083ReqSchema, Oidb0x9083RespSchema);
  const uin = resp?.inner?.userInfo?.uin;
  const users = uin ? [{ uin: Number(uin) }] : [];
  const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
  return { users, cookie: respCookie, isLast: !respCookie };
}
