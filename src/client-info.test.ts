import { afterEach, describe, expect, it, vi } from 'vitest';
import type BijiSyncPlugin from './main';
import { TimerRegistry } from './timers';
const request = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async original => ({ ...await original<typeof import('obsidian')>(), requestUrl: request }));
import { ClientInfoReporter, collectClientInfo } from './client-info';
function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', undefined);
  vi.stubGlobal('window', globalThis);
  request.mockReset(); request.mockResolvedValue({ status: 200 });
  const storage = new Map<string, unknown>();
  let allowed = true;
  const plugin = { settings: { installationId: 'instance-0001', apiKey: 'first-key', syncInterval: 0, syncOnStart: true, preventReimportAfterLocalRemoval: true,
    syncContentMode: 'full', syncContentOrder: 'note-first', imageMode: 'local', mergeMode: 'none', template: '{{content}}' },
    manifest: { version: '1.0.29' }, app: { loadLocalStorage: (key: string) => storage.get(key), saveLocalStorage: (key: string, value: unknown) => storage.set(key, value) },
    timers: new TimerRegistry(), clientInfoAllowed: () => allowed, logger: { log: vi.fn() },
  } as unknown as BijiSyncPlugin;
  const reporter = new ClientInfoReporter(plugin);
  return { reporter, plugin, storage, disable: () => { allowed = false; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('automatic client snapshots', () => {
  it('sends nothing before binding', async () => {
    const { reporter, disable } = fixture(); disable();
    reporter.changed(0); await vi.advanceTimersByTimeAsync(86400000);
    expect(request).not.toHaveBeenCalled(); reporter.stop();
  });
  it('debounces, removes secrets, deduplicates and sends a daily heartbeat even with manual sync', async () => {
    const fixtureState = fixture(); const { reporter, plugin } = fixtureState;
    plugin.settings.syncInterval = 0;
    reporter.changed(); reporter.changed();
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledOnce();
    const body = request.mock.calls[0][0].body;
    expect(body).not.toContain('first-key'); expect(body).not.toContain('authorization');
    reporter.changed(); await vi.advanceTimersByTimeAsync(5000); expect(request).toHaveBeenCalledOnce();
    plugin.settings.syncOnStart = !plugin.settings.syncOnStart;
    reporter.changed(); await vi.advanceTimersByTimeAsync(5000); expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(86400000); expect(request).toHaveBeenCalledTimes(3);
    reporter.stop();
  });
  it('does not send while unbound and ignores a response after an account switch', async () => {
    const { reporter, plugin, storage, disable } = fixture();
    request.mockImplementationOnce(async () => { plugin.settings.apiKey = ''; disable(); return { status: 200 }; });
    reporter.changed(0); await vi.advanceTimersByTimeAsync(0);
    expect(storage.size).toBe(0);
    reporter.changed(0); await vi.advanceTimersByTimeAsync(10000); expect(request).toHaveBeenCalledOnce();
    reporter.stop();
  });
  it('obeys Retry-After despite setting changes and stops after 401', async () => {
    const { reporter, plugin } = fixture();
    request.mockResolvedValueOnce({ status: 429, headers: { 'Retry-After': '120' } });
    reporter.changed(0); await vi.advanceTimersByTimeAsync(0);
    plugin.settings.syncOnStart = false; reporter.changed(); await vi.advanceTimersByTimeAsync(10000); expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce({ status: 401 }); await vi.advanceTimersByTimeAsync(110000); expect(request).toHaveBeenCalledTimes(2);
    reporter.changed(); await vi.advanceTimersByTimeAsync(86400000); expect(request).toHaveBeenCalledTimes(2);
    reporter.stop();
  });
  it('handles unsupported desktop snapshots and old servers without repeated requests', async () => {
    const { reporter, plugin } = fixture();
    expect((await collectClientInfo(plugin)).desktop.supported).toBe(false);
    request.mockResolvedValue({ status: 404 }); reporter.changed(0); await vi.advanceTimersByTimeAsync(0);
    reporter.changed(); await vi.advanceTimersByTimeAsync(10000); expect(request).toHaveBeenCalledOnce();
    reporter.stop();
  });
  it('preserves versions supplied by old companions without reading authorization', async () => {
    const { plugin, reporter } = fixture();
    plugin.companion = { snapshot: () => ({ enabled: false, runtimeVersion: '0.2.3', deployment: 'companion',
      tools: { ffmpeg: 'ffmpeg version 6.1.1 Copyright (c) FFmpeg', ytdlp: '2026.10.21', whisper: 'not-checked' },
      getFeedbackInfo: vi.fn() }) } as unknown as BijiSyncPlugin['companion'];
    const snapshot = await collectClientInfo(plugin);
    expect(snapshot.desktop.runtimeVersion).toBe('0.2.3'); expect(snapshot.desktop.supported).toBe(false);
    expect(snapshot.desktop.tools).toEqual({ ffmpeg: '6.1.1', ytdlp: '2026.10.21', whisper: 'not-checked' });
    expect(plugin.companion?.snapshot()?.getFeedbackInfo).not.toHaveBeenCalled();
    reporter.stop();
  });
  it('reports tool version tokens without sending the surrounding tool output', async () => {
    const { plugin, reporter } = fixture();
    const desktop = { supported: true, tools: {
      ffmpeg: 'ffmpeg version N-118106-gabc123 built in /Users/private',
      ytdlp: '2026.10.21.123456 [private build]',
      whisper: 'whisper.cpp version: 1.9.5-dev',
      ffmpegCapabilities: 'verified',
      ytdlpCapabilities: 'unknown output /Users/private',
      unknown: '1.0',
    } };
    plugin.companion = { snapshot: () => ({ capabilities: ['client-info-v1'], getClientInfo: async () => desktop }) } as unknown as BijiSyncPlugin['companion'];
    reporter.changed(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(request.mock.calls[0][0].body).desktop.tools).toEqual({
      ffmpeg: 'N-118106-gabc123', ytdlp: '2026.10.21.123456', whisper: '1.9.5-dev', ffmpegCapabilities: 'verified',
    });
    reporter.stop();
  });
});
