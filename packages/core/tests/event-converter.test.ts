import { describe, expect, it } from 'vitest';
import { EventConverter } from '../src/onebot/event-converter';
import {
  buildDispatchPayload,
  pickDispatchJson,
  resolveReportOptions,
  shapeEventForAdapter,
} from '../src/onebot/event-filter';
import type { FriendMessage, GroupMessage, TempMessage } from '../src/bridge/events';

const SELF_UIN = '10001';
const SELF_ID = 10001;
const PEER_UIN = 22222;

function makeFriendMessage(senderUin: number): FriendMessage {
  return {
    kind: 'friend_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin,
    senderNick: senderUin === SELF_ID ? 'me' : 'peer',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function makeGroupMessage(senderUin: number): GroupMessage {
  return {
    kind: 'group_message',
    time: 1700000000,
    selfUin: SELF_ID,
    groupId: 99999,
    senderUin,
    senderNick: senderUin === SELF_ID ? 'me' : 'peer',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function makeTempMessage(senderUin: number): TempMessage {
  return {
    kind: 'temp_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin,
    groupId: 99999,
    senderNick: senderUin === SELF_ID ? 'me' : 'peer',
    msgSeq: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

describe('EventConverter post_type tagging', () => {
  it('tags self friend_message as message_sent', async () => {
    const conv = new EventConverter();
    const result = await conv.convert(SELF_UIN, makeFriendMessage(SELF_ID));
    expect(result).not.toBeNull();
    expect(result!.post_type).toBe('message_sent');
    expect(result!.message_type).toBe('private');
    expect(result!.user_id).toBe(SELF_ID);
    expect(result!.self_id).toBe(SELF_ID);
  });

  it('tags self group_message as message_sent', async () => {
    const conv = new EventConverter();
    const result = await conv.convert(SELF_UIN, makeGroupMessage(SELF_ID));
    expect(result!.post_type).toBe('message_sent');
    expect(result!.message_type).toBe('group');
  });

  it('tags self temp_message as message_sent', async () => {
    const conv = new EventConverter();
    const result = await conv.convert(SELF_UIN, makeTempMessage(SELF_ID));
    expect(result!.post_type).toBe('message_sent');
    expect(result!.sub_type).toBe('group');
  });

  it('keeps incoming peer messages tagged as plain message', async () => {
    const conv = new EventConverter();
    const friend = await conv.convert(SELF_UIN, makeFriendMessage(PEER_UIN));
    expect(friend!.post_type).toBe('message');
    expect(friend!.user_id).toBe(PEER_UIN);

    const group = await conv.convert(SELF_UIN, makeGroupMessage(PEER_UIN));
    expect(group!.post_type).toBe('message');
  });
});

describe('shapeEventForAdapter', () => {
  const baseEvent = {
    time: 1,
    self_id: SELF_ID,
    post_type: 'message_sent' as const,
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    user_id: SELF_ID,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: SELF_ID, nickname: 'me', sex: 'unknown', age: 0 },
  };

  it('drops self message_sent when adapter has reportSelfMessage=false', () => {
    const opts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
    expect(shapeEventForAdapter(baseEvent, opts)).toBeNull();
  });

  it('keeps self message_sent when adapter has reportSelfMessage=true', () => {
    const opts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });
    const shaped = shapeEventForAdapter(baseEvent, opts);
    expect(shaped).not.toBeNull();
    expect(shaped!.post_type).toBe('message_sent');
  });

  it('rewrites message to CQ string when format=string', () => {
    const opts = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: true });
    const shaped = shapeEventForAdapter(baseEvent, opts);
    expect(shaped).not.toBeNull();
    expect(shaped!.message).toBe('hello');
    // raw_message is preserved untouched.
    expect(shaped!.raw_message).toBe('hello');
  });

  it('keeps message as array when format=array (default)', () => {
    const opts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });
    const shaped = shapeEventForAdapter(baseEvent, opts);
    expect(Array.isArray(shaped!.message)).toBe(true);
  });

  it('defaults partially-deserialized adapters to array format and no self report', () => {
    const opts = resolveReportOptions({});
    expect(opts.messageFormat).toBe('array');
    expect(opts.reportSelfMessage).toBe(false);
  });

  it('passes through non-message events unchanged', () => {
    const noticeEvent = {
      time: 1,
      self_id: SELF_ID,
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: 1,
      user_id: 2,
    };
    const opts = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: false });
    expect(shapeEventForAdapter(noticeEvent, opts)).toBe(noticeEvent);
  });
});

describe('buildDispatchPayload + pickDispatchJson', () => {
  const messageEvent = {
    time: 1,
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    user_id: PEER_UIN,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: PEER_UIN, nickname: 'peer', sex: 'unknown', age: 0 },
  };

  const selfMessageEvent = { ...messageEvent, post_type: 'message_sent', user_id: SELF_ID };

  const noticeEvent = {
    time: 1,
    self_id: SELF_ID,
    post_type: 'notice',
    notice_type: 'group_increase',
    group_id: 1,
    user_id: 2,
  };

  it('builds at most two distinct JSON variants for a message event', () => {
    const payload = buildDispatchPayload(messageEvent);
    expect(payload.isSelfMessage).toBe(false);

    const arr = JSON.parse(payload.arrayJson);
    const str = JSON.parse(payload.stringJson);
    expect(Array.isArray(arr.message)).toBe(true);
    expect(typeof str.message).toBe('string');
    expect(str.message).toBe('hello');
    expect(str.raw_message).toBe('hello');
    // every other field should be byte-identical
    const { message: _arrMsg, ...arrRest } = arr;
    const { message: _strMsg, ...strRest } = str;
    expect(arrRest).toEqual(strRest);
  });

  it('flags self messages and uses identical JSON for non-message events', () => {
    const selfPayload = buildDispatchPayload(selfMessageEvent);
    expect(selfPayload.isSelfMessage).toBe(true);

    const noticePayload = buildDispatchPayload(noticeEvent);
    expect(noticePayload.isSelfMessage).toBe(false);
    // Non-message events do not need a separate string variant.
    expect(noticePayload.arrayJson).toBe(noticePayload.stringJson);
  });

  it('routes connections to the right pre-serialized variant in O(1)', () => {
    const payload = buildDispatchPayload(messageEvent);
    const arrayOpt = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
    const stringOpt = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: false });

    expect(pickDispatchJson(payload, arrayOpt)).toBe(payload.arrayJson);
    expect(pickDispatchJson(payload, stringOpt)).toBe(payload.stringJson);
  });

  it('drops self-message dispatches for adapters that opt out', () => {
    const payload = buildDispatchPayload(selfMessageEvent);
    const offOpt = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
    expect(pickDispatchJson(payload, offOpt)).toBeNull();

    const onOpt = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });
    const json = pickDispatchJson(payload, onOpt);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).post_type).toBe('message_sent');
  });

  it('serializes only twice regardless of fan-out size', () => {
    const payload = buildDispatchPayload(messageEvent);
    // Mixed fleet of adapters with different formats / self-report options.
    const adapters = Array.from({ length: 50 }, (_, i) => i % 2 === 0
      ? { messageFormat: 'array' as const, reportSelfMessage: false }
      : { messageFormat: 'string' as const, reportSelfMessage: true },
    );
    const seen = new Set(
      adapters
        .map((opts) => pickDispatchJson(payload, opts))
        .filter((j): j is string => j !== null),
    );
    // No matter the fan-out, only at most the two prebuilt strings appear.
    expect(seen.size).toBeLessThanOrEqual(2);
    expect(seen.has(payload.arrayJson)).toBe(true);
    expect(seen.has(payload.stringJson)).toBe(true);
  });
});
