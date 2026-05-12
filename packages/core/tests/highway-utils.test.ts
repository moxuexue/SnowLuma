import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { loadBinarySource, resolveLocalFilePath } from '../src/bridge/highway/utils';

describe('highway source paths', () => {
  it('normalizes file URLs with an extra leading slash on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(resolveLocalFilePath('file:////AstrBot/data/plugin/cache/BV-test.mp4'))
      .toBe('/AstrBot/data/plugin/cache/BV-test.mp4');
  });

  it('loads encoded file URLs from the local filesystem', async () => {
    const filePath = path.join(os.tmpdir(), `snowluma video ${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'ok');

    try {
      const source = pathToFileURL(filePath).href;
      const loaded = await loadBinarySource(source, 'test file');
      expect(Buffer.from(loaded.bytes).toString('utf8')).toBe('ok');
      expect(loaded.fileName).toBe(path.basename(filePath));
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  });
});
