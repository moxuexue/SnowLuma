import type { BridgeManager } from '../bridge/manager';
import type { NtqqHandler } from '../protocol/ntqq-handler';
import { createLogger } from '../utils/logger';
import { HookPacketClient } from './hook-packet-client';
import { injectHookProcess, listHookProcesses, unloadHookProcess, type HookInjectResult, type HookProcessBaseInfo } from './injector';
import { QqHookClient, type QqHookLoginState, type QqHookPacket } from './qq-hook-client';

const log = createLogger('Hook');
const DEFAULT_WATCHER_INTERVAL_MS = 1500;
const MIN_WATCHER_INTERVAL_MS = 250;

export type HookProcessStatus =
  | 'available'
  | 'loading'
  | 'connecting'
  | 'loaded'
  | 'online'
  | 'error'
  | 'disconnected';

export interface HookProcessInfo extends HookProcessBaseInfo {
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: HookProcessStatus;
  error: string;
  method: string;
}

interface HookProcessState extends HookProcessInfo {
  client: QqHookClient | null;
  sender: HookPacketClient | null;
  injectResult: HookInjectResult | null;
  bound: boolean;
}

export interface HookManagerOptions {
  /** Background pipe-watcher polling interval. Lower = faster reconnect but
   * more frequent named-pipe directory listings. Defaults to 1500 ms. */
  watcherIntervalMs?: number;
}

/**
 * Manages SnowLuma hook injection and bridge connectivity for QQ.exe processes.
 *
 * Lifecycle: load -> inject DLL only (returns fast) -> background watcher
 * detects the named pipe coming up and connects -> on QQ login the bridge is
 * notified. The watcher also handles reconnect after a pipe drop and detects
 * hooks that survived a previous SnowLuma restart.
 *
 * Concurrency: every per-PID mutation (load / unload / refresh / connect /
 * close-handler / watcher reconcile) goes through a per-PID promise chain so
 * users can spam buttons without races.
 */
export class HookManager {
  private readonly states = new Map<number, HookProcessState>();
  private readonly opsByPid = new Map<number, Promise<unknown>>();
  private readonly watcherIntervalMs: number;
  private watcherTimer: NodeJS.Timeout | null = null;
  private watcherTicking = false;
  private disposed = false;

  constructor(
    private readonly ntqq: NtqqHandler,
    private readonly bridgeManager: BridgeManager,
    options: HookManagerOptions = {},
  ) {
    this.watcherIntervalMs = Math.max(
      MIN_WATCHER_INTERVAL_MS,
      options.watcherIntervalMs ?? DEFAULT_WATCHER_INTERVAL_MS,
    );
    // Boot the watcher on the next tick so callers can attach listeners first.
    this.scheduleWatcher(0);
  }

  async listProcesses(): Promise<HookProcessInfo[]> {
    const processes = listHookProcesses();
    for (const proc of processes) {
      const state = this.ensureState(proc.pid);
      state.name = proc.name || state.name;
      state.path = proc.path || state.path;
    }
    const result: HookProcessInfo[] = [];
    for (const proc of processes) {
      result.push(this.toPublicInfo(this.ensureState(proc.pid)));
    }
    return result.sort((a, b) => a.pid - b.pid);
  }

  loadProcess(pid: number): Promise<HookProcessInfo> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
    return this.serialize(pid, () => this.loadProcessInternal(pid));
  }

  unloadProcess(pid: number): Promise<HookProcessInfo> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
    return this.serialize(pid, () => this.unloadProcessInternal(pid));
  }

  /**
   * Re-probe the named pipe for `pid`, reconnect if it became available,
   * or tear down a stale connection if it disappeared. Safe to call at any
   * time; serialised against load/unload/watcher actions on the same PID.
   */
  refreshProcess(pid: number): Promise<HookProcessInfo> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
    return this.serialize(pid, () => this.refreshProcessInternal(pid));
  }

  dispose(): void {
    this.disposed = true;
    if (this.watcherTimer) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = null;
    }
    for (const state of this.states.values()) {
      this.tearDownClient(state);
      state.status = state.injected ? 'disconnected' : 'available';
    }
  }

  // ───────────────────────── per-PID serialization ─────────────────────────

  /**
   * Serialise an operation against a per-PID promise chain. Guarantees that
   * load / unload / refresh / watcher-driven connects for the same PID never
   * interleave even if the user mashes buttons.
   */
  private async serialize<T>(pid: number, op: () => Promise<T>): Promise<T> {
    const previous = this.opsByPid.get(pid) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    const chained = previous.then(() => completion);
    this.opsByPid.set(pid, chained);
    try {
      await previous.catch(() => undefined);
      return await op();
    } finally {
      release();
      // Drop the chain entry once nothing else is waiting on it.
      if (this.opsByPid.get(pid) === chained) this.opsByPid.delete(pid);
    }
  }

  // ──────────────────────────── load / unload ──────────────────────────────

  private async loadProcessInternal(pid: number): Promise<HookProcessInfo> {
    const state = this.ensureState(pid);
    state.error = '';
    state.status = 'loading';

    try {
      if (!state.injected) {
        // Fast path: a previous SnowLuma run may have left the hook DLL
        // resident in QQ.exe. If the control pipe is already listed we skip
        // re-injection and let the watcher reconnect instead.
        const livePipes = await QqHookClient.listLivePipes();
        if (livePipes.has(pid)) {
          state.injected = true;
          state.method = state.method || 'reconnect';
          log.info('PID=%d already has SnowLuma pipe; will reconnect via watcher', pid);
        } else {
          state.injectResult = injectHookProcess(pid);
          state.injected = true;
          state.method = state.injectResult.method;
        }
      }
      state.status = state.connected
        ? (state.loggedIn ? 'online' : 'loaded')
        : 'connecting';
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      log.error('load failed: PID=%d err=%s', pid, state.error);
    }

    // Wake the watcher so it can pick up the freshly-injected pipe asap
    // instead of waiting up to one full interval.
    this.scheduleWatcher(0);
    return this.toPublicInfo(state);
  }

  private async unloadProcessInternal(pid: number): Promise<HookProcessInfo> {
    const state = this.ensureState(pid);
    state.error = '';

    try {
      const wasLoggedIn = state.loggedIn;
      this.tearDownClient(state);
      if (wasLoggedIn) this.bridgeManager.onPidDisconnected(pid);

      const handle = state.injectResult?.handle;
      if (state.injected && handle) {
        unloadHookProcess(pid, handle);
        log.info('SnowLuma unloaded from PID=%d via unloadModuleManual', pid);
      }

      // Clear injection state first
      state.injected = false;
      state.injectResult = null;
      state.method = '';
      state.uin = '0';

      // Verify unload succeeded by checking if pipe still exists
      const livePipes = await QqHookClient.listLivePipes();
      if (livePipes.has(pid)) {
        // Pipe still exists - unload failed, but let watcher handle reconnection
        state.error = 'DLL卸载失败：命名管道仍然存在，watcher将自动重连';
        state.status = 'connecting';  // Let watcher pick it up and reconnect
        log.warn('unload verification failed: PID=%d pipe still exists after unloadModuleManual, watcher will reconnect', pid);
      } else {
        // Successfully unloaded
        state.status = 'available';
        state.error = '';
      }
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      log.error('unload failed: PID=%d err=%s', pid, state.error);
    }

    return this.toPublicInfo(state);
  }

  private async refreshProcessInternal(pid: number): Promise<HookProcessInfo> {
    const state = this.ensureState(pid);
    state.error = '';

    try {
      const livePipes = await QqHookClient.listLivePipes();
      const pipeUp = livePipes.has(pid);

      if (pipeUp) {
        // A live pipe means a SnowLuma DLL is resident — even if we did not
        // inject it ourselves (e.g. left over from a prior run).
        if (!state.injected) {
          state.injected = true;
          state.method = state.method || 'reconnect';
        }
        if (state.client?.isClosed) this.tearDownClient(state);
        if (!state.connected) {
          await this.attemptConnect(state);
        } else {
          state.status = state.loggedIn ? 'online' : 'loaded';
        }
      } else {
        // Pipe is gone; if we still hold a client, drop it and surface the
        // appropriate disconnected/available state to the UI.
        const wasLoggedIn = state.loggedIn;
        this.tearDownClient(state);
        if (wasLoggedIn) this.bridgeManager.onPidDisconnected(pid);
        state.status = state.injected ? 'disconnected' : 'available';
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = state.injected ? 'disconnected' : 'error';
      log.warn('refresh failed: PID=%d err=%s', pid, state.error);
    }

    return this.toPublicInfo(state);
  }

  private ensureState(pid: number): HookProcessState {
    let state = this.states.get(pid);
    if (!state) {
      state = {
        pid,
        name: 'QQ.exe',
        path: '',
        injected: false,
        connected: false,
        loggedIn: false,
        uin: '0',
        status: 'available',
        error: '',
        method: '',
        client: null,
        sender: null,
        injectResult: null,
        bound: false,
      };
      this.states.set(pid, state);
    }
    return state;
  }

  // ───────────────────────────── pipe watcher ──────────────────────────────

  private scheduleWatcher(delayMs: number): void {
    if (this.disposed) return;
    if (this.watcherTimer) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = null;
    }
    this.watcherTimer = setTimeout(() => {
      this.watcherTimer = null;
      void this.tickWatcher();
    }, Math.max(0, delayMs));
  }

  private async tickWatcher(): Promise<void> {
    if (this.disposed) return;
    if (this.watcherTicking) {
      this.scheduleWatcher(this.watcherIntervalMs);
      return;
    }
    this.watcherTicking = true;
    try {
      const livePipes = await QqHookClient.listLivePipes();
      const processes = listHookProcesses();
      const runningSet = new Set(processes.map(p => p.pid));

      // Refresh metadata + ensure a state entry exists for each known PID.
      for (const proc of processes) {
        const state = this.ensureState(proc.pid);
        state.name = proc.name || state.name;
        state.path = proc.path || state.path;
      }
      // Auto-detect hooks that survived a SnowLuma restart or failed unload.
      for (const pid of livePipes) {
        if (!runningSet.has(pid)) continue;
        const state = this.ensureState(pid);
        if (!state.injected) {
          state.injected = true;
          state.method = state.method || 'reconnect';
          if (state.status === 'available') state.status = 'connecting';
          log.info('Detected pre-existing SnowLuma pipe in PID=%d', pid);
        }
      }

      const tasks: Promise<unknown>[] = [];
      for (const state of [...this.states.values()]) {
        const alivePipe = livePipes.has(state.pid);
        const aliveProc = runningSet.has(state.pid);

        if (!aliveProc) {
          const wasLoggedIn = state.loggedIn;
          this.tearDownClient(state);
          if (wasLoggedIn) this.bridgeManager.onPidDisconnected(state.pid);
          this.states.delete(state.pid);
          continue;
        }

        // Pipe vanished but we still hold a client → schedule a teardown.
        if (state.connected && !alivePipe) {
          tasks.push(this.serialize(state.pid, async () => this.reconcileLostPipe(state.pid))
            .catch(err => log.warn('watcher teardown failed: PID=%d err=%s', state.pid, this.errMsg(err))));
          continue;
        }

        // Injected & pipe up but not connected → schedule a connect.
        if (state.injected && !state.connected && alivePipe) {
          tasks.push(this.serialize(state.pid, async () => this.reconcileConnect(state.pid))
            .catch(err => log.warn('watcher connect failed: PID=%d err=%s', state.pid, this.errMsg(err))));
          continue;
        }

        // Injected but pipe still pending → keep status visible to the UI.
        if (state.injected && !state.connected && !alivePipe) {
          if (state.status !== 'error' && state.status !== 'disconnected' && state.status !== 'loading') {
            state.status = 'connecting';
          }
        }
      }
      await Promise.all(tasks);
    } finally {
      this.watcherTicking = false;
      this.scheduleWatcher(this.watcherIntervalMs);
    }
  }

  /** Re-check pipe and connect under the per-PID lock. */
  private async reconcileConnect(pid: number): Promise<void> {
    const state = this.states.get(pid);
    if (!state || !state.injected || state.connected) return;
    if (state.client?.isClosed) this.tearDownClient(state);
    const live = await QqHookClient.listLivePipes();
    if (!live.has(pid)) return;
    await this.attemptConnect(state);
  }

  /** Tear down a client whose pipe disappeared. */
  private async reconcileLostPipe(pid: number): Promise<void> {
    const state = this.states.get(pid);
    if (!state || !state.connected) return;
    const live = await QqHookClient.listLivePipes();
    if (live.has(pid)) return;
    const wasLoggedIn = state.loggedIn;
    this.tearDownClient(state);
    state.status = state.injected ? (wasLoggedIn ? 'disconnected' : 'connecting') : 'available';
    if (wasLoggedIn) this.bridgeManager.onPidDisconnected(pid);
  }

  // ───────────────────────────── client plumbing ───────────────────────────

  private async attemptConnect(state: HookProcessState): Promise<void> {
    if (state.connected) return;
    if (state.client?.isClosed) this.tearDownClient(state);
    if (!state.client) {
      state.client = new QqHookClient(state.pid);
      state.sender = new HookPacketClient(state.client);
      state.bound = false;
    }
    if (!state.bound) {
      this.bindClient(state, state.client);
      state.bound = true;
    }

    const client = state.client;
    try {
      await client.connectAll({ recv: true });
      state.connected = true;
      state.status = client.isLoggedIn ? 'online' : 'loaded';
      state.error = '';
      const loginState = client.getLoginState();
      if (loginState.loggedIn) this.handleLoginState(state, loginState);
      log.info('pipe connected: PID=%d', state.pid);
    } catch (error) {
      state.error = this.errMsg(error);
      // Drop the client so the next attempt builds a fresh socket pair.
      this.tearDownClient(state);
      state.status = state.injected ? 'connecting' : 'available';
    }
  }

  private bindClient(state: HookProcessState, client: QqHookClient): void {
    client.on('packet', packet => this.handlePacket(state, packet));
    client.on('loginState', loginState => this.handleLoginState(state, loginState));
    client.on('error', error => {
      const msg = this.errMsg(error);
      state.error = msg;
      log.warn('pipe error: PID=%d err=%s', state.pid, msg);
    });
    client.on('close', () => {
      if (this.disposed) return;
      // Only the client that is currently registered should drive a reconcile;
      // listeners may fire for an already-replaced client.
      if (state.client !== client) return;
      void this.serialize(state.pid, async () => {
        if (state.client !== client) return;
        const wasLoggedIn = state.loggedIn;
        this.tearDownClient(state);
        if (!state.injected) {
          state.status = 'available';
        } else if (wasLoggedIn) {
          state.status = 'disconnected';
          this.bridgeManager.onPidDisconnected(state.pid);
        } else {
          state.status = 'connecting';
        }
      }).catch(err => log.warn('close reconcile failed: PID=%d err=%s', state.pid, this.errMsg(err)));
    });
  }

  /** Detach + close the current client and reset its associated fields. */
  private tearDownClient(state: HookProcessState): void {
    const client = state.client;
    if (client) {
      client.removeAllListeners();
      try { client.close(); } catch { /* ignore */ }
    }
    state.client = null;
    state.sender = null;
    state.bound = false;
    state.connected = false;
    state.loggedIn = false;
  }

  private handleLoginState(state: HookProcessState, loginState: QqHookLoginState): void {
    const wasLoggedIn = state.loggedIn;
    const previousUin = state.uin;
    state.uin = loginState.uin || loginState.uinNumber.toString();
    state.loggedIn = loginState.loggedIn && isRealUin(state.uin);
    state.status = state.loggedIn ? 'online' : (state.connected ? 'loaded' : state.status);

    if (!state.loggedIn || !state.sender) return;
    if (wasLoggedIn && previousUin === state.uin) return;

    this.bridgeManager.onHookLogin(state.pid, state.uin, state.sender);
    log.success('login detected: PID=%d UIN=%s', state.pid, state.uin);
  }

  private handlePacket(state: HookProcessState, packet: QqHookPacket): void {
    if (!state.loggedIn) return;
    const uin = packet.uin || state.uin;
    if (!isRealUin(uin)) return;
    this.ntqq.onHookPacket(state.pid, { ...packet, uin });
  }

  private toPublicInfo(state: HookProcessState): HookProcessInfo {
    return {
      pid: state.pid,
      name: state.name,
      path: state.path,
      injected: state.injected,
      connected: state.connected,
      loggedIn: state.loggedIn,
      uin: state.uin,
      status: state.status,
      error: state.error,
      method: state.method,
    };
  }

  private errMsg(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }
}

function isRealUin(uin: string): boolean {
  if (!uin || uin === '0') return false;
  return /^\d+$/.test(uin) && uin.length >= 5;
}
