import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediaUrlResolver } from '../src/onebot/media-url-resolver';
import type { MessageElement } from '../src/bridge/events';

// Minimal stand-ins for the two collaborators. Each test wires whatever
// subset of Bridge methods the element type exercises.

function makeBridge(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    fetchGroupFileUrl: vi.fn(async () => 'http://group/file'),
    fetchPrivateFileUrl: vi.fn(async () => 'http://private/file'),
    fetchGroupPttUrlByNode: vi.fn(async () => 'http://group/ptt'),
    fetchPrivatePttUrlByNode: vi.fn(async () => 'http://private/ptt'),
    fetchGroupVideoUrlByNode: vi.fn(async () => 'http://group/video'),
    fetchPrivateVideoUrlByNode: vi.fn(async () => 'http://private/video'),
    ...overrides,
  };
}

function makeRkey(overrides: { resolveMediaUrl?: ReturnType<typeof vi.fn> } = {}) {
  return {
    resolveMediaUrl: overrides.resolveMediaUrl ?? vi.fn(async (_bridge, el: MessageElement) => el.url ?? ''),
  };
}

const MEDIA_NODE = { fileUuid: 'uuid-1' };

describe('MediaUrlResolver — file element', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let rkey: ReturnType<typeof makeRkey>;
  beforeEach(() => { bridge = makeBridge(); rkey = makeRkey(); });

  it('group + fileId: uses fetchGroupFileUrl, then applies rkey', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'file', fileId: 'fid-x' };
    const out = await resolver.resolve(element, true, 12345);
    expect(bridge.fetchGroupFileUrl).toHaveBeenCalledWith(12345, 'fid-x');
    expect(element.url).toBe('http://group/file');
    expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
    expect(out).toBe('http://group/file');
  });

  it('c2c + fileId + fileHash: uses fetchPrivateFileUrl', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'file', fileId: 'fid-x', fileHash: 'hash-y' };
    await resolver.resolve(element, false, 67890);
    expect(bridge.fetchPrivateFileUrl).toHaveBeenCalledWith(67890, 'fid-x', 'hash-y');
    expect(element.url).toBe('http://private/file');
  });

  it('c2c + fileId but no fileHash: sets url to empty string (no bridge call)', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'file', fileId: 'fid-x' };
    await resolver.resolve(element, false, 67890);
    expect(bridge.fetchPrivateFileUrl).not.toHaveBeenCalled();
    expect(element.url).toBe('');
  });
});

describe('MediaUrlResolver — record / video element', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let rkey: ReturnType<typeof makeRkey>;
  beforeEach(() => { bridge = makeBridge(); rkey = makeRkey(); });

  it('group record: uses fetchGroupPttUrlByNode', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
    await resolver.resolve(element, true, 12345);
    expect(bridge.fetchGroupPttUrlByNode).toHaveBeenCalledWith(12345, MEDIA_NODE);
    expect(element.url).toBe('http://group/ptt');
  });

  it('c2c record: uses fetchPrivatePttUrlByNode (no sessionId argument)', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
    await resolver.resolve(element, false, 67890);
    expect(bridge.fetchPrivatePttUrlByNode).toHaveBeenCalledWith(MEDIA_NODE);
    expect(element.url).toBe('http://private/ptt');
  });

  it('group video: uses fetchGroupVideoUrlByNode', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'video', mediaNode: MEDIA_NODE };
    await resolver.resolve(element, true, 12345);
    expect(bridge.fetchGroupVideoUrlByNode).toHaveBeenCalledWith(12345, MEDIA_NODE);
    expect(element.url).toBe('http://group/video');
  });

  it('c2c video: uses fetchPrivateVideoUrlByNode', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'video', mediaNode: MEDIA_NODE };
    await resolver.resolve(element, false, 67890);
    expect(bridge.fetchPrivateVideoUrlByNode).toHaveBeenCalledWith(MEDIA_NODE);
    expect(element.url).toBe('http://private/video');
  });

  it('record without mediaNode: no bridge call, url untouched', async () => {
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'record' };
    await resolver.resolve(element, true, 12345);
    expect(bridge.fetchGroupPttUrlByNode).not.toHaveBeenCalled();
    expect(element.url).toBeUndefined();
  });
});

describe('MediaUrlResolver — short-circuits and resilience', () => {
  it('element.url already set: no bridge call, just rkey pass', async () => {
    const bridge = makeBridge();
    const rkey = makeRkey();
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'file', fileId: 'fid', url: 'already-set' };
    await resolver.resolve(element, true, 12345);
    expect(bridge.fetchGroupFileUrl).not.toHaveBeenCalled();
    expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
  });

  it('bridge throws: swallowed, rkey still applied', async () => {
    const bridge = makeBridge({
      fetchGroupFileUrl: vi.fn(async () => { throw new Error('network down'); }),
    });
    const rkey = makeRkey({ resolveMediaUrl: vi.fn(async () => 'rkey-fallback') });
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'file', fileId: 'fid' };
    const out = await resolver.resolve(element, true, 12345);
    expect(out).toBe('rkey-fallback');
    expect(element.url).toBeUndefined(); // bridge threw before assignment
  });

  it('always calls rkey.resolveMediaUrl at the end', async () => {
    const bridge = makeBridge();
    const rkey = makeRkey({ resolveMediaUrl: vi.fn(async () => 'http://signed') });
    const resolver = new MediaUrlResolver(bridge as any, rkey as any);
    const element: MessageElement = { type: 'image' };
    const out = await resolver.resolve(element, true, 12345);
    expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
    expect(out).toBe('http://signed');
  });
});
