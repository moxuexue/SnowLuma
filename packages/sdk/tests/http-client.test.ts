import { describe, expect, it, vi } from 'vitest';
import {
  SnowLumaAbortError,
  SnowLumaAuthError,
  SnowLumaHttpClient,
  SnowLumaParseError,
} from '../src';

describe('SnowLumaHttpClient', () => {
  it('throws SnowLumaAuthError for auth retcodes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'failed',
      retcode: 1401,
      data: null,
      wording: 'unauthorized',
    })));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });

    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaAuthError);
  });

  it('throws SnowLumaParseError for non-JSON responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });

    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaParseError);
  });

  it('supports caller AbortSignal cancellation', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
    }));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });
    const controller = new AbortController();

    const request = client.getStatus({ signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(SnowLumaAbortError);
  });
});
