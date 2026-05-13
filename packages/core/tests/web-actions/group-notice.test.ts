import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/web-actions/cookies', () => ({
  getCookies: vi.fn(async () => ({ p_skey: 'psk' })),
}));

vi.mock('../../src/bridge/web/group-notice', () => ({
  setGroupNoticeWebAPI: vi.fn(async () => ({ ec: 0 })),
  getGroupNoticeWebAPI: vi.fn(async () => ({ feeds: {} })),
  uploadGroupNoticeImage: vi.fn(async () => null),
  deleteGroupNotice: vi.fn(async () => true),
}));

import * as cookies from '../../src/bridge/web-actions/cookies';
import * as noticeWeb from '../../src/bridge/web/group-notice';
import {
  sendGroupNotice,
  getGroupNotice,
  deleteGroupNoticeByFid,
} from '../../src/bridge/web-actions/group-notice';

const bridge = {} as any;

describe('group-notice — sendGroupNotice', () => {
  beforeEach(() => {
    vi.mocked(cookies.getCookies).mockClear();
    vi.mocked(noticeWeb.setGroupNoticeWebAPI).mockReset();
    vi.mocked(noticeWeb.uploadGroupNoticeImage).mockReset();
  });

  it('text-only: dispatches with empty picId and default image dims (540x300)', async () => {
    vi.mocked(noticeWeb.setGroupNoticeWebAPI).mockResolvedValueOnce({ ec: 0 } as any);
    await sendGroupNotice(bridge, 12345, 'hello');

    expect(noticeWeb.uploadGroupNoticeImage).not.toHaveBeenCalled();
    const args = vi.mocked(noticeWeb.setGroupNoticeWebAPI).mock.calls[0]!;
    expect(args[1]).toBe('12345');     // groupCode
    expect(args[2]).toBe('hello');     // content
    expect(args[3]).toBe(0);           // pinned default
    expect(args[4]).toBe(1);           // type default
    expect(args[7]).toBe(1);           // confirm_required default
    expect(args[8]).toBe('');          // picId
    expect(args[9]).toBe(540);         // imgWidth default
    expect(args[10]).toBe(300);        // imgHeight default
  });

  it('with options: forwards pinned / type / confirm_required overrides', async () => {
    vi.mocked(noticeWeb.setGroupNoticeWebAPI).mockResolvedValueOnce({ ec: 0 } as any);
    await sendGroupNotice(bridge, 12345, 'pinned!', {
      pinned: 1,
      type: 2,
      confirm_required: 0,
    });
    const args = vi.mocked(noticeWeb.setGroupNoticeWebAPI).mock.calls[0]!;
    expect(args[3]).toBe(1);
    expect(args[4]).toBe(2);
    expect(args[7]).toBe(0);
  });

  it('with http image: fetches bytes, uploads, threads pic info into the post', async () => {
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as any;

    vi.mocked(noticeWeb.uploadGroupNoticeImage).mockResolvedValueOnce({
      id: 'pic-xyz', width: 1024, height: 768,
    } as any);
    vi.mocked(noticeWeb.setGroupNoticeWebAPI).mockResolvedValueOnce({ ec: 0 } as any);

    await sendGroupNotice(bridge, 12345, 'image notice', { image: 'https://example.com/x.png' });

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(noticeWeb.uploadGroupNoticeImage).toHaveBeenCalledOnce();
    const args = vi.mocked(noticeWeb.setGroupNoticeWebAPI).mock.calls[0]!;
    expect(args[8]).toBe('pic-xyz');
    expect(args[9]).toBe(1024);
    expect(args[10]).toBe(768);

    global.fetch = realFetch;
  });

  it('image fetch failure: throws "Failed to download image"', async () => {
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as any;
    await expect(sendGroupNotice(bridge, 12345, 'x', { image: 'https://bad' }))
      .rejects.toThrow(/Failed to download image: 503/);
    global.fetch = realFetch;
  });

  it('throws when the web API returns non-zero ec', async () => {
    vi.mocked(noticeWeb.setGroupNoticeWebAPI).mockResolvedValueOnce({
      ec: 42, em: 'permission denied',
    } as any);
    await expect(sendGroupNotice(bridge, 12345, 'x'))
      .rejects.toThrow(/permission denied/);
  });

  it('throws with a generic message when ec≠0 and em is missing', async () => {
    vi.mocked(noticeWeb.setGroupNoticeWebAPI).mockResolvedValueOnce({ ec: 7 } as any);
    await expect(sendGroupNotice(bridge, 12345, 'x'))
      .rejects.toThrow(/Cookie过期或权限不足/);
  });
});

describe('group-notice — getGroupNotice', () => {
  beforeEach(() => { vi.mocked(noticeWeb.getGroupNoticeWebAPI).mockReset(); });

  it('flattens feeds into OneBot-shaped notice list', async () => {
    vi.mocked(noticeWeb.getGroupNoticeWebAPI).mockResolvedValueOnce({
      feeds: {
        f1: {
          fid: 'f1', u: 10001, pubt: 1700000000,
          msg: { text: 'first', pics: [{ id: 'p1', h: 100, w: 200 }] },
          settings: {}, read_num: 5,
        } as any,
        f2: {
          fid: 'f2', u: 10002, pubt: 1700000100,
          msg: { text: 'second' } as any,
          settings: {}, read_num: 0,
        } as any,
      },
    } as any);

    const out = await getGroupNotice(bridge, 12345);
    expect(out).toHaveLength(2);
    expect(out[0]!.notice_id).toBe('f1');
    expect(out[0]!.message.text).toBe('first');
    expect(out[0]!.message.image).toEqual([{ id: 'p1', height: 100, width: 200 }]);
    expect(out[0]!.message.images).toEqual(out[0]!.message.image);   // alias
    expect(out[1]!.message.image).toEqual([]);                        // no pics → empty
  });

  it('throws when the underlying web API returns null', async () => {
    vi.mocked(noticeWeb.getGroupNoticeWebAPI).mockResolvedValueOnce(null as any);
    await expect(getGroupNotice(bridge, 12345)).rejects.toThrow(/获取公告失败/);
  });

  it('returns an empty array when feeds is empty', async () => {
    vi.mocked(noticeWeb.getGroupNoticeWebAPI).mockResolvedValueOnce({ feeds: {} } as any);
    expect(await getGroupNotice(bridge, 12345)).toEqual([]);
  });
});

describe('group-notice — deleteGroupNoticeByFid', () => {
  it('delegates to deleteGroupNotice with cookieObject + groupCode + fid', async () => {
    vi.mocked(noticeWeb.deleteGroupNotice).mockResolvedValueOnce(true);
    const ok = await deleteGroupNoticeByFid(bridge, 12345, 'fid-abc');
    expect(ok).toBe(true);
    const args = vi.mocked(noticeWeb.deleteGroupNotice).mock.calls[0]!;
    expect(args[1]).toBe('12345');
    expect(args[2]).toBe('fid-abc');
  });
});
