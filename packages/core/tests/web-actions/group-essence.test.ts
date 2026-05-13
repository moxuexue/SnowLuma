import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/web-actions/cookies', () => ({
  getCookies: vi.fn(async () => ({ p_skey: 'psk' })),
}));

vi.mock('../../src/bridge/web/group-essence', () => ({
  getGroupEssenceMsg: vi.fn(async () => null),
  getGroupEssenceMsgAll: vi.fn(async () => []),
}));

import * as cookies from '../../src/bridge/web-actions/cookies';
import * as essenceWeb from '../../src/bridge/web/group-essence';
import {
  getGroupEssence,
  getGroupEssenceAll,
} from '../../src/bridge/web-actions/group-essence';

const bridge = {} as any;

describe('group-essence', () => {
  beforeEach(() => {
    vi.mocked(cookies.getCookies).mockClear();
    vi.mocked(essenceWeb.getGroupEssenceMsg).mockReset();
    vi.mocked(essenceWeb.getGroupEssenceMsgAll).mockReset();
  });

  it('getGroupEssence: passes pageStart + pageLimit through to the web API', async () => {
    vi.mocked(essenceWeb.getGroupEssenceMsg).mockResolvedValueOnce({
      retcode: 0,
      data: { is_end: true, msg_list: [{ a: 1 }] },
    } as any);

    const out = await getGroupEssence(bridge, 12345, 10, 20);
    const args = vi.mocked(essenceWeb.getGroupEssenceMsg).mock.calls[0]!;
    expect(args[1]).toBe('12345');  // groupCode
    expect(args[2]).toBe(10);       // pageStart
    expect(args[3]).toBe(20);       // pageLimit
    expect((out as any).data.msg_list).toHaveLength(1);
  });

  it('getGroupEssence: defaults pageStart=0 + pageLimit=50', async () => {
    vi.mocked(essenceWeb.getGroupEssenceMsg).mockResolvedValueOnce({
      retcode: 0,
      data: { is_end: true, msg_list: [] },
    } as any);
    await getGroupEssence(bridge, 12345);
    const args = vi.mocked(essenceWeb.getGroupEssenceMsg).mock.calls[0]!;
    expect(args[2]).toBe(0);
    expect(args[3]).toBe(50);
  });

  it('getGroupEssence: falls back to an empty result envelope when the API returns null', async () => {
    vi.mocked(essenceWeb.getGroupEssenceMsg).mockResolvedValueOnce(null as any);
    const out = await getGroupEssence(bridge, 12345);
    expect(out).toEqual({ retcode: -1, data: { is_end: true, msg_list: [] } });
  });

  it('getGroupEssenceAll: delegates to the all-pages web helper', async () => {
    vi.mocked(essenceWeb.getGroupEssenceMsgAll).mockResolvedValueOnce([
      { retcode: 0, data: { is_end: false, msg_list: [{}] } },
      { retcode: 0, data: { is_end: true, msg_list: [{}, {}] } },
    ] as any);
    const out = await getGroupEssenceAll(bridge, 12345);
    expect(out).toHaveLength(2);
    expect(vi.mocked(essenceWeb.getGroupEssenceMsgAll).mock.calls[0]![1]).toBe('12345');
  });
});
