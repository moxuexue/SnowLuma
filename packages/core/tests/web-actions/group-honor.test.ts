import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/web-actions/cookies', () => ({
  getCookies: vi.fn(async () => ({ p_skey: 'psk' })),
}));

vi.mock('../../src/bridge/web/group-honor', async () => {
  // Keep the real WebHonorType enum so the function-under-test still
  // sees the same constants as production code; only the network call
  // (`getHonorListWebAPI`) is faked.
  const actual = await vi.importActual<typeof import('../../src/bridge/web/group-honor')>('../../src/bridge/web/group-honor');
  return {
    ...actual,
    getHonorListWebAPI: vi.fn(async () => [] as Array<unknown>),
  };
});

import * as cookies from '../../src/bridge/web-actions/cookies';
import * as honorWeb from '../../src/bridge/web/group-honor';
import { WebHonorType } from '../../src/bridge/web/group-honor';
import { getGroupHonorInfo } from '../../src/bridge/web-actions/group-honor';

const bridge = {} as any;

describe('group-honor — getGroupHonorInfo', () => {
  beforeEach(() => {
    vi.mocked(cookies.getCookies).mockClear();
    vi.mocked(honorWeb.getHonorListWebAPI).mockReset();
  });

  it('TALKATIVE: calls API only for type=1, populates current_talkative + talkative_list', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValueOnce([
      { uin: 10001, nick: 'alice', avatar: '', desc: '' },
      { uin: 10002, nick: 'bob', avatar: '', desc: '' },
    ]);

    const out = await getGroupHonorInfo(bridge, 12345, WebHonorType.TALKATIVE);
    expect(honorWeb.getHonorListWebAPI).toHaveBeenCalledTimes(1);
    expect(vi.mocked(honorWeb.getHonorListWebAPI).mock.calls[0]![2]).toBe(1);
    expect(out.current_talkative).toEqual({ uin: 10001, nick: 'alice', avatar: '', desc: '' });
    expect(out.talkative_list).toHaveLength(2);
    expect(out.performer_list).toEqual([]);
    expect(out.legend_list).toEqual([]);
    expect(out.emotion_list).toEqual([]);
  });

  it('TALKATIVE with empty list: current_talkative stays null', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValueOnce([]);
    const out = await getGroupHonorInfo(bridge, 12345, WebHonorType.TALKATIVE);
    expect(out.current_talkative).toBeNull();
    expect(out.talkative_list).toEqual([]);
  });

  it('PERFORMER: dispatches API with type=2 only', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValueOnce([{ uin: 1, nick: 'p', avatar: '', desc: '' }]);
    const out = await getGroupHonorInfo(bridge, 12345, WebHonorType.PERFORMER);
    expect(vi.mocked(honorWeb.getHonorListWebAPI).mock.calls[0]![2]).toBe(2);
    expect(out.performer_list).toHaveLength(1);
    expect(out.talkative_list).toEqual([]);
  });

  it('LEGEND: type=3', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValueOnce([]);
    await getGroupHonorInfo(bridge, 12345, WebHonorType.LEGEND);
    expect(vi.mocked(honorWeb.getHonorListWebAPI).mock.calls[0]![2]).toBe(3);
  });

  it('EMOTION: type=6', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValueOnce([]);
    await getGroupHonorInfo(bridge, 12345, WebHonorType.EMOTION);
    expect(vi.mocked(honorWeb.getHonorListWebAPI).mock.calls[0]![2]).toBe(6);
  });

  it('ALL: fetches talkative + performer + legend + emotion (4 calls)', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValue([]);
    await getGroupHonorInfo(bridge, 12345, WebHonorType.ALL);
    expect(honorWeb.getHonorListWebAPI).toHaveBeenCalledTimes(4);
    expect(vi.mocked(honorWeb.getHonorListWebAPI).mock.calls.map(c => c[2])).toEqual([1, 2, 3, 6]);
  });

  it('groupId is stringified to groupCode', async () => {
    vi.mocked(honorWeb.getHonorListWebAPI).mockResolvedValueOnce([]);
    await getGroupHonorInfo(bridge, 99999, WebHonorType.TALKATIVE);
    expect(vi.mocked(honorWeb.getHonorListWebAPI).mock.calls[0]![1]).toBe('99999');
  });
});
