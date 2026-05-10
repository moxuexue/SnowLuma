import type { Bridge } from '../bridge/bridge';
import type { QQInfo } from '../bridge/qq-info';
import type { BridgeManager } from '../bridge/manager';
import { loadOneBotConfig } from './config';
import { OneBotInstance } from './instance';
import { createLogger } from '../utils/logger';

const log = createLogger('OneBot');
const VERBOSE_WARMUP = process.env.SNOWLUMA_VERBOSE_WARMUP === '1';

export class OneBotManager {
  private readonly instances = new Map<string, OneBotInstance>();

  bind(bridgeManager: BridgeManager): void {
    bridgeManager.setSessionStartedCallback((uin, qqInfo, bridge) => {
      this.onSessionStarted(uin, qqInfo, bridge);
    });

    bridgeManager.setSessionClosedCallback((uin) => {
      this.onSessionClosed(uin);
    });

    // Per-kind subscriptions to `bridge.events` happen inside
    // `OneBotInstance` itself; no global firehose to wire here.
  }

  getInstance(uin: string): OneBotInstance | null {
    return this.instances.get(uin) ?? null;
  }

  getInstances(): OneBotInstance[] {
    return [...this.instances.values()];
  }

  reloadConfig(uin: string): boolean {
    const instance = this.instances.get(uin);
    if (!instance) return false;

    const config = loadOneBotConfig(uin);
    instance.reloadConfig(config);
    log.info('configuration reloaded: UIN=%s', uin);
    return true;
  }

  dispose(): void {
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }

  private onSessionStarted(uin: string, qqInfo: QQInfo, bridge: Bridge): void {
    if (this.instances.has(uin)) return;

    const config = loadOneBotConfig(uin);
    const instance = new OneBotInstance(uin, qqInfo, bridge, config);

    const activePid = bridge.activePid;
    if (activePid !== null) {
      instance.addPid(activePid);
    }

    this.instances.set(uin, instance);
    log.info('session started: UIN=%s', uin);

    // Warm up bridge state asynchronously (mirrors C++ warm_up_bridge_state)
    warmUpBridgeState(uin, qqInfo, bridge).catch((err) => {
      log.warn('warmup error for UIN %s: %s', uin, err instanceof Error ? (err.stack ?? err.message) : String(err));
    });
  }

  private onSessionClosed(uin: string): void {
    const instance = this.instances.get(uin);
    if (!instance) return;

    instance.dispose();
    this.instances.delete(uin);
    log.info('session closed: UIN=%s', uin);
  }

}

async function warmUpBridgeState(uin: string, qqInfo: QQInfo, bridge: Bridge): Promise<void> {
  // Step 1: Fetch friend list + derive self profile
  try {
    const friends = await bridge.fetchFriendList();
    log.info('friends loaded: UIN=%s count=%d', uin, friends.length);

    const selfUin = parseInt(uin, 10) || 0;
    for (const f of friends) {
      if (f.uin === selfUin) {
        qqInfo.setSelfProfile({
          uin: f.uin, uid: f.uid,
          nickname: f.nickname || uin,
          remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '',
        });
        qqInfo.nickname = f.nickname || uin;
        log.debug('self info: UIN=%s uid=%s nickname=%s', uin, f.uid, f.nickname ?? '');
        break;
      }
    }
  } catch (e) {
    log.warn('failed to load friends for UIN %s: %s', uin, e instanceof Error ? e.message : String(e));
  }

  // Step 2: Fetch group list
  let groups: { groupId: number }[] = [];
  try {
    groups = await bridge.fetchGroupList();
    log.info('groups loaded: UIN=%s count=%d', uin, groups.length);
  } catch (e) {
    log.warn('failed to load groups for UIN %s: %s', uin, e instanceof Error ? e.message : String(e));
  }

  // Step 3: Fetch members for each group
  let loadedGroupCount = 0;
  let loadedMemberCount = 0;
  let failedGroupCount = 0;
  for (const g of groups) {
    try {
      const members = await bridge.fetchGroupMemberList(g.groupId);
      loadedGroupCount += 1;
      loadedMemberCount += members.length;
      if (VERBOSE_WARMUP) {
        log.debug('members loaded: group=%d count=%d', g.groupId, members.length);
      }
    } catch (e) {
      failedGroupCount += 1;
      log.warn('failed to load members for group %d: %s', g.groupId, e instanceof Error ? e.message : String(e));
    }
  }

  log.info(
    'member warmup completed: UIN=%s groups=%d/%d members=%d failed=%d',
    uin,
    loadedGroupCount,
    groups.length,
    loadedMemberCount,
    failedGroupCount,
  );
}
