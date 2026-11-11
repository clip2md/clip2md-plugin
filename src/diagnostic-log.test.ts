import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { LocalLogger, readLog, redact, errorDetail } from './diagnostic-log';
import { boundedFlush, trimReport } from './local-diagnostics';
function fixture() {
  const files = new Map<string, string>(); const folders = new Set<string>(); const local = new Map<string, unknown>();
  const adapter = { exists: async (path: string) => files.has(path) || folders.has(path),
    read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
    write: vi.fn(async (path: string, text: string) => { files.set(path, text); }), mkdir: async (path: string) => { folders.add(path); },
    rename: async (source: string, target: string) => { files.set(target, files.get(source)!); files.delete(source); }, remove: async (path: string) => { files.delete(path); } };
  const app = { vault: { configDir: '.obsidian', adapter }, loadLocalStorage: (key: string) => local.get(key), saveLocalStorage: (key: string, value: unknown) => local.set(key, value) } as unknown as App;
  return { files, adapter, logger: new LocalLogger(app, 'clipmd', '1.0.29') };
}
afterEach(() => { vi.useRealTimers(); });
describe('bounded detailed diagnostics', () => {
  it('recovers an error buffered by a failed write before a queued report flush completes', async () => {
    const { logger, adapter, files } = fixture(); await logger.flush();
    adapter.write.mockRejectedValueOnce(new Error('disk temporarily unavailable'));
    logger.log('sync.failed', {}, 'error', undefined, new Error('must survive'));
    await logger.flush();
    expect(readLog(files.get(logger.path)!).entries[0].details?.message).toBe('must survive');
    logger.stop();
  });
  it('scrubs credentials, private paths, links, emails and nested causes before persistence', async () => {
    const { logger, files } = fixture();
    const cause = new Error('Authorization: Bearer private-key\n/Users/private/file.md https://example.com/?secret=private');
    const error = new Error('write failed clip2md_12345678_sensitive person@example.com', { cause });
    logger.log('sync.failed', { taskId: 7 }, 'error', undefined, error);
    await logger.flush();
    const text = files.get(logger.path)!;
    expect(text).not.toMatch(/private-key|\/Users\/private|example.com|sensitive|person@/);
    const entry = readLog(text).entries[0];
    expect(entry.details?.cause?.name).toBe('Error'); expect(entry.fields.taskId).toBe(7);
    const cyclic = { name: 'Error', message: 'cycle', cause: {} }; cyclic.cause = cyclic;
    expect(errorDetail(cyclic)?.cause).toBeUndefined();
    expect(redact('at app://x/.obsidian/plugins/clipmd/main.js:1:123')).toContain('clipmd/main.js:1:123');
    expect(redact('write failed Notes/私人笔记.md and Command failed: ffmpeg --private-option')).not.toMatch(/私人笔记|--private-option/);
    logger.stop();
  });
  it('batches ordinary logs and flushes immediately after errors', async () => {
    vi.useFakeTimers(); const { logger, adapter } = fixture(); await logger.flush(); adapter.write.mockClear();
    logger.log('sync.started'); await vi.advanceTimersByTimeAsync(4999); expect(adapter.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(adapter.write).toHaveBeenCalledOnce();
    logger.log('sync.failed', {}, 'error', undefined, new Error('failure'));
    await vi.advanceTimersByTimeAsync(0); expect(adapter.write).toHaveBeenCalledTimes(2);
    logger.stop();
  });
  it('redacts long path components completely and scrubs text that already contains markers', () => {
    const privateName = 'private'.repeat(1000);
    expect(redact(`write [path] ${privateName}/note.md`)).toBe('write [path] [path]');
    expect(redact(`write Notes/${privateName}`)).toBe('write [path]');
    expect(redact('[path] Authorization: Bearer secret-value')).toBe('[path] [credential]');
  });
  it('handles long non-matches within the redaction budget', () => {
    const text = 'a.'.repeat(32768);
    const started = performance.now();
    expect(redact(text, 65536)).toBe(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
  it('cleans seven-day history, preserves optional details and ignores fields an old reader drops', async () => {
    const { logger, files } = fixture(); logger.log('plugin.start'); await logger.flush();
    const file = readLog(files.get(logger.path)!);
    file.entries[0].time = new Date(Date.now() - 8 * 86400000).toISOString();
    files.set(logger.path, JSON.stringify(file));
    logger.log('sync.finished'); await logger.flush();
    expect(readLog(files.get(logger.path)!).entries.map(entry => entry.event)).toEqual(['sync.finished']);
    logger.stop();
  });
  it('bounds cross-plugin flush to two seconds and distinguishes failure and missing capability', async () => {
    vi.useFakeTimers();
    const result = boundedFlush({ clipmd: async () => { throw new Error('disk'); }, 'clipmd-desktop-tools': () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ clipmd: 'error', 'clipmd-desktop-tools': 'timeout' });
    expect((await boundedFlush({})).clipmd).toBe('unavailable');
  });
  it('protects the latest 200 available errors while enforcing the byte limit', async () => {
    const { logger, files } = fixture(); logger.log('sync.failed', {}, 'error', undefined, new Error('x'.repeat(2048))); await logger.flush();
    const base = readLog(files.get(logger.path)!).entries[0];
    const entries = Array.from({ length: 700 }, (_, index) => ({ ...base, time: new Date(index * 1000).toISOString(), level: index < 400 ? 'info' as const : 'error' as const }));
    const report = { logs: [{ entries }], discarded: { info: 0, warn: 0, error: 0 }, protectedErrors: 0 };
    trimReport(report, 1200 * 1024);
    expect(report.protectedErrors).toBe(200);
    const errors = report.logs[0].entries.filter(entry => entry.level === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(200);
    expect(errors.slice(-200).map(entry => entry.time)).toEqual(entries.slice(-200).map(entry => entry.time));
    expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThanOrEqual(1200 * 1024);
    logger.stop();
  });
});
