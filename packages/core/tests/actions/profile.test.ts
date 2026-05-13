import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  sendOidbAndCheck: vi.fn(async () => undefined),
  sendOidbAndDecode: vi.fn(async () => ({})),
  resolveUserUid: vi.fn(async () => 'resolved-uid'),
  makeOidbRequest: vi.fn(() => new Uint8Array(0)),
}));

vi.mock('../../src/bridge/highway/highway-client', () => ({
  fetchHighwaySession: vi.fn(async () => ({})),
  uploadHighwayHttp: vi.fn(async () => undefined),
}));

vi.mock('../../src/bridge/highway/utils', () => ({
  loadBinarySource: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), fileName: 'avatar.bin' })),
  computeHashes: vi.fn(() => ({ md5: new Uint8Array(16), sha1: new Uint8Array(20) })),
  computeMd5: vi.fn(() => new Uint8Array(16)),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as highwayClient from '../../src/bridge/highway/highway-client';
import * as profile from '../../src/bridge/actions/profile';
import { mockBridge } from './_helpers';

describe('actions/profile', () => {
  beforeEach(() => {
    vi.mocked(oidb.sendOidbAndCheck).mockClear();
    vi.mocked(oidb.sendOidbAndDecode).mockClear();
    vi.mocked(oidb.resolveUserUid).mockClear();
    vi.mocked(highwayClient.fetchHighwaySession).mockClear();
    vi.mocked(highwayClient.uploadHighwayHttp).mockClear();
  });

  it('setOnlineStatus sends to status_svc.SetStatus and accepts an empty response', async () => {
    const bridge = mockBridge();
    await profile.setOnlineStatus(bridge as any, 11, 0, 100);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.qq_new_tech.status_svc.StatusService.SetStatus');
  });

  it('setProfile is a no-op when both arguments are undefined', async () => {
    const bridge = mockBridge();
    await profile.setProfile(bridge as any);
    expect(oidb.sendOidbAndCheck).not.toHaveBeenCalled();
  });

  it('setProfile only sends non-undefined fields', async () => {
    const bridge = mockBridge();
    await profile.setProfile(bridge as any, 'New Nick');
    expect(oidb.sendOidbAndCheck).toHaveBeenCalledOnce();
    const body: any = vi.mocked(oidb.sendOidbAndCheck).mock.calls[0]![4];
    expect(body.stringProfiles).toEqual([{ fieldId: 20002, value: 'New Nick' }]);
  });

  it('setSelfLongNick wraps the long nick in profile tag 102', async () => {
    const bridge = mockBridge();
    await profile.setSelfLongNick(bridge as any, 'hello world');
    const call = vi.mocked(oidb.sendOidbAndDecode).mock.calls[0]!;
    expect((call[4] as any).profile).toEqual({ tag: 102, value: 'hello world' });
  });

  it('setInputStatus resolves UID first and sends 0xcd4_1', async () => {
    const bridge = mockBridge();
    await profile.setInputStatus(bridge as any, 10001, 1);
    expect(oidb.resolveUserUid).toHaveBeenCalledWith(bridge, 10001);
    const call = vi.mocked(oidb.sendOidbAndDecode).mock.calls[0]!;
    expect(call[1]).toBe('OidbSvcTrpcTcp.0xcd4_1');
  });

  it('setAvatar loads bytes and pushes through the highway upload path (cmd 90)', async () => {
    const bridge = mockBridge();
    await profile.setAvatar(bridge as any, '/some/avatar.png');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    const [, , cmdId] = vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]!;
    expect(cmdId).toBe(90);
  });

  it('getProfileLike (self): resolves self UID, returns formatted favorite + vote info', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.sendOidbAndDecode).mockResolvedValueOnce({
      userLikeInfos: [{
        uid: 'u',
        time: 1700000000n,
        favoriteInfo: { totalCount: 5, lastTime: 1n, newCount: 1 },
        voteInfo: { totalCount: 7, newCount: 2, lastTime: 2n },
      }],
    });
    const out = await profile.getProfileLike(bridge as any);
    expect(out.favoriteInfo.total_count).toBe(5);
    expect(out.voteInfo.total_count).toBe(7);
  });

  it('getProfileLike throws on empty result', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.sendOidbAndDecode).mockResolvedValueOnce({ userLikeInfos: [] });
    await expect(profile.getProfileLike(bridge as any)).rejects.toThrow(/empty/);
  });

  it('getUnidirectionalFriendList parses the embedded JSON body', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.sendOidbAndDecode).mockResolvedValueOnce({
      jsonBody: JSON.stringify({ rpt_block_list: [{ uin: 10001 }, { uin: 10002 }] }),
    });
    const out = await profile.getUnidirectionalFriendList(bridge as any);
    expect(out).toEqual([{ uin: 10001 }, { uin: 10002 }]);
  });
});
