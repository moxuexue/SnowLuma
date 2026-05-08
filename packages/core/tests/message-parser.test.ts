import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/onebot/message-parser';
import { buildSendElems } from '../src/bridge/builders/element-builder';
import { MentionExtraSendSchema } from '../src/bridge/proto/action';
import { protoDecode } from '../src/protobuf/decode';

describe('parseMessage', () => {
  describe('plain text', () => {
    it('parses simple text', async () => {
      const result = await parseMessage('hello world', false);
      expect(result).toEqual([{ type: 'text', text: 'hello world' }]);
    });

    it('returns empty for empty string', async () => {
      const result = await parseMessage('', false);
      expect(result).toEqual([]);
    });

    it('autoEscape treats CQ codes as text', async () => {
      const result = await parseMessage('[CQ:face,id=123]', true);
      expect(result).toEqual([{ type: 'text', text: '[CQ:face,id=123]' }]);
    });
  });

  describe('CQ code parsing', () => {
    it('parses face CQ code', async () => {
      const result = await parseMessage('[CQ:face,id=123]', false);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(123);
    });

    it('parses at CQ code', async () => {
      const result = await parseMessage('[CQ:at,qq=12345]', false);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('at');
      expect(result[0].targetUin).toBe(12345);
    });

    it('parses at all', async () => {
      const result = await parseMessage('[CQ:at,qq=all]', false);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('at');
      expect(result[0].targetUin).toBe(0);
    });

    it('parses mixed text and CQ codes', async () => {
      const result = await parseMessage('Hello [CQ:face,id=1] World', false);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'text', text: 'Hello ' });
      expect(result[1].type).toBe('face');
      expect(result[2]).toEqual({ type: 'text', text: ' World' });
    });

    it('unescapes CQ special chars', async () => {
      const result = await parseMessage('a&amp;b&#91;c&#93;d', false);
      expect(result).toEqual([{ type: 'text', text: 'a&b[c]d' }]);
    });
  });

  describe('JSON segment array', () => {
    it('parses text segment', async () => {
      const result = await parseMessage(
        [{ type: 'text', data: { text: 'hello' } }] as any,
        false,
      );
      expect(result).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('parses face segment', async () => {
      const result = await parseMessage(
        [{ type: 'face', data: { id: 123 } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(123);
    });

    it('parses image segment', async () => {
      const result = await parseMessage(
        [{ type: 'image', data: { file: 'https://example.com/img.png' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('image');
      expect(result[0].url).toBe('https://example.com/img.png');
    });

    it('parses at segment', async () => {
      const result = await parseMessage(
        [{ type: 'at', data: { qq: 12345 } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('at');
      expect(result[0].targetUin).toBe(12345);
    });

    it('uses at segment name for display text and preserves uid', async () => {
      const result = await parseMessage(
        [{ type: 'at', data: { qq: '123456', name: 'User', uid: 'u_test_uid' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'at',
        targetUin: 123456,
        uid: 'u_test_uid',
        text: '@User ',
      });
    });

    it('resolves missing at uid through parse options', async () => {
      const result = await parseMessage(
        [{ type: 'at', data: { qq: '123456', name: 'User' } }] as any,
        false,
        { resolveMentionUid: async (targetUin) => targetUin === 123456 ? 'u_resolved_uid' : null },
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'at',
        targetUin: 123456,
        uid: 'u_resolved_uid',
        text: '@User ',
      });
    });

    it('encodes mention extra with resolved uid for QQ notification', async () => {
      const elements = await parseMessage(
        [{ type: 'at', data: { qq: '123456', name: 'User' } }] as any,
        false,
        { resolveMentionUid: () => 'u_resolved_uid' },
      );
      const protoElems = await buildSendElems(elements);
      const reserve = protoElems[0].text?.pbReserve;
      expect(reserve).toBeInstanceOf(Uint8Array);
      const extra = protoDecode(reserve as Uint8Array, MentionExtraSendSchema);
      expect(extra).toMatchObject({
        type: 2,
        uin: 123456,
        uid: 'u_resolved_uid',
      });
      expect(protoElems[0].text?.str).toBe('@User ');
    });

    it('parses multiple segments', async () => {
      const result = await parseMessage(
        [
          { type: 'text', data: { text: 'hi ' } },
          { type: 'at', data: { qq: 999 } },
          { type: 'text', data: { text: ' there' } },
        ] as any,
        false,
      );
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('text');
      expect(result[1].type).toBe('at');
      expect(result[2].type).toBe('text');
    });

    it('skips unknown segment types', async () => {
      const result = await parseMessage(
        [
          { type: 'text', data: { text: 'ok' } },
          { type: 'unknown_type_xyz', data: {} },
        ] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
    });
  });

  describe('special segments', () => {
    it('parses json segment', async () => {
      const result = await parseMessage(
        [{ type: 'json', data: { data: '{"app":"test"}' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBe('{"app":"test"}');
    });

    it('parses reply segment with resolveReplySequence', async () => {
      const result = await parseMessage(
        [{ type: 'reply', data: { id: 42 } }] as any,
        false,
        { resolveReplySequence: (id) => id === 42 ? 100 : null },
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('reply');
      expect(result[0].replySeq).toBe(100);
    });

    it('parses share as json card', async () => {
      const result = await parseMessage(
        [{ type: 'share', data: { url: 'https://example.com', title: 'Test' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBeDefined();
      const parsed = JSON.parse(result[0].text!);
      expect(parsed.app).toBe('com.tencent.structmsg');
      expect(parsed.meta.news.title).toBe('Test');
    });

    it('parses rps as face', async () => {
      const result = await parseMessage(
        [{ type: 'rps', data: {} }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(359);
    });

    it('parses dice as face', async () => {
      const result = await parseMessage(
        [{ type: 'dice', data: {} }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(358);
    });

    it('parses shake as poke', async () => {
      const result = await parseMessage(
        [{ type: 'shake', data: {} }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('poke');
    });

    it('ignores anonymous segment', async () => {
      const result = await parseMessage(
        [
          { type: 'anonymous', data: {} },
          { type: 'text', data: { text: 'hi' } },
        ] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
    });

    it('parses location as json card', async () => {
      const result = await parseMessage(
        [{ type: 'location', data: { lat: '39.9', lon: '116.3', title: 'Beijing' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBeDefined();
      const parsed = JSON.parse(result[0].text!);
      expect(parsed.app).toBe('com.tencent.map');
      expect(parsed.meta.Location.lat).toBe('39.9');
    });

    it('parses contact as json card', async () => {
      const result = await parseMessage(
        [{ type: 'contact', data: { type: 'group', id: '12345' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBeDefined();
      const parsed = JSON.parse(result[0].text!);
      expect(parsed.meta.contact.type).toBe('group');
    });
  });

  describe('single segment object', () => {
    it('parses single segment object', async () => {
      const result = await parseMessage(
        { type: 'text', data: { text: 'single' } } as any,
        false,
      );
      expect(result).toEqual([{ type: 'text', text: 'single' }]);
    });
  });

  describe('edge cases', () => {
    it('returns empty for null', async () => {
      const result = await parseMessage(null as any, false);
      expect(result).toEqual([]);
    });

    it('returns empty for number', async () => {
      const result = await parseMessage(42 as any, false);
      expect(result).toEqual([]);
    });
  });
});
