import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  sendOidbAndCheck: vi.fn(async () => undefined),
  sendOidbAndDecode: vi.fn(async () => ({})),
  resolveUserUid: vi.fn(async () => 'resolved-uid'),
  makeOidbRequest: vi.fn(() => new Uint8Array(0)),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as msg from '../../src/bridge/actions/group-message';
import { mockBridge } from './_helpers';

describe('actions/group-message', () => {
  beforeEach(() => {
    vi.mocked(oidb.sendOidbAndCheck).mockClear();
    vi.mocked(oidb.resolveUserUid).mockClear();
  });

  it('recallGroupMessage sends to SsoGroupRecallMsg with the group sequence', async () => {
    const bridge = mockBridge();
    await msg.recallGroupMessage(bridge as any, 12345, 999);
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg');
  });

  it('recallGroupMessage throws when sendRawPacket reports failure', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: 'network down',
        responseData: null,
      })) as any,
    });
    await expect(msg.recallGroupMessage(bridge as any, 12345, 999))
      .rejects.toThrow(/network down/);
  });

  it('recallPrivateMessage resolves the target UID before dispatch', async () => {
    const bridge = mockBridge();
    await msg.recallPrivateMessage(bridge as any, 10001, 100, 200, 123, 1700000000);
    expect(oidb.resolveUserUid).toHaveBeenCalledWith(bridge, 10001);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg');
  });

  it('markGroupMessageRead and markPrivateMessageRead both hit SsoReadedReport', async () => {
    const bridge = mockBridge();
    await msg.markGroupMessageRead(bridge as any, 12345, 50);
    await msg.markPrivateMessageRead(bridge as any, 10001, 60);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
    const cmds = bridge.sendRawPacket.mock.calls.map((c: any) => c[0]);
    expect(cmds).toEqual([
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
    ]);
  });

  it('setGroupEssence picks _1 for enable and _2 for disable', async () => {
    const bridge = mockBridge();
    await msg.setGroupEssence(bridge as any, 12345, 5, 7, true);
    await msg.setGroupEssence(bridge as any, 12345, 5, 7, false);
    const cmds = vi.mocked(oidb.sendOidbAndCheck).mock.calls.map(c => c[1]);
    expect(cmds).toEqual(['OidbSvcTrpcTcp.0xeac_1', 'OidbSvcTrpcTcp.0xeac_2']);
  });
});
