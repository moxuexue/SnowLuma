import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookManager } from '../src/hook/hook-manager';
import { PipeWatcher } from '../src/hook/pipe-watcher';
import type { ManualMapHandle } from '../src/hook/injector';
import type { BridgeManager } from '../src/bridge/manager';
import type { QqHookClient } from '../src/hook/qq-hook-client';

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };
const flush = () => new Promise<void>(r => setImmediate(r));

function makeManager(opts: {
  autoLoadOnDiscovery?: boolean;
  processes?: number[];
}) {
  let pids = opts.processes ?? [];
  const live = new Set<number>();
  const inject = vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE }));
  const unload = vi.fn();
  const pipeWatcher = new PipeWatcher({
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
    listLivePipes: async () => new Set(live),
    intervalMs: 60_000,  // disable internal timer; tests drive ticks manually
  });
  // FakeClient — never connected; just needs to satisfy EventEmitter +
  // a minimal subset of QqHookClient for HookSession.tearDownClient().
  const makeClient = vi.fn(() => {
    const c = new EventEmitter() as EventEmitter & Partial<QqHookClient>;
    (c as any).isClosed = false;
    (c as any).isLoggedIn = false;
    (c as any).getLoginState = () => ({ loggedIn: false, uin: '0', uinNumber: 0n });
    (c as any).connectAll = async () => { throw new Error('test: never really connect'); };
    (c as any).close = () => { (c as any).isClosed = true; };
    return c as unknown as QqHookClient;
  });
  const bridgeManager = {
    onPacket: vi.fn(),
    onHookLogin: vi.fn(),
    onPidDisconnected: vi.fn(),
  } as unknown as BridgeManager;
  const manager = new HookManager({
    bridgeManager,
    pipeWatcher,
    injector: { inject, unload },
    makeClient,
    autoLoadOnDiscovery: opts.autoLoadOnDiscovery,
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
  });
  return {
    manager,
    inject,
    pipeWatcher,
    setProcesses: (next: number[]) => { pids = next; },
  };
}

describe('HookManager.autoLoadOnDiscovery', () => {
  it('does NOT inject on process-discovered when flag is off', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: false, processes: [4242] });
    await ctx.pipeWatcher.start();
    await flush();
    expect(ctx.inject).not.toHaveBeenCalled();
    ctx.manager.dispose();
  });

  it('injects every newly-discovered PID when flag is on', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    await ctx.pipeWatcher.start();
    // session.load() is queued via a per-session promise chain; flush twice
    // so the auto-load runs to completion before we assert.
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(1);
    expect(ctx.inject).toHaveBeenCalledWith(4242);

    // A second PID appearing mid-flight should also trigger an inject.
    ctx.setProcesses([4242, 9999]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(2);
    expect(ctx.inject).toHaveBeenLastCalledWith(9999);

    ctx.manager.dispose();
  });

  it('swallows inject errors so the watcher keeps running', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject.mockImplementationOnce(() => { throw new Error('ptrace denied'); });
    await ctx.pipeWatcher.start();
    await flush();
    await flush();

    // Second PID should still be auto-loaded — the failure on 4242 must
    // not leak out of the listener and break the watcher's emit loop.
    ctx.setProcesses([4242, 9999]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(2);

    ctx.manager.dispose();
  });
});
