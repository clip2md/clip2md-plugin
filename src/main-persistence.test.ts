import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings } from './settings';
import { SyncService } from './sync';
import { SyncAckQueue } from './sync-ack';

describe('plugin state persistence', () => {
    it('serializes settings writes without losing the cursor, file map, pending IDs or receipts', async () => {
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
        const settings: BijiSyncSettings = {
            apiKey: 'api-key', installationId: 'test', settingsSchemaVersion: 3,
            syncInterval: 60, syncOnStart: false, targetFolder: 'Original',
            filenameTemplate: '{{title}}', filenameDateFormat: 'yyyy-MM-dd',
            template: '{{content}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
            syncContentMode: 'full', imageMode: 'local', imageFolder: '',
            mergeMode: 'none',
        };
        plugin.settings = settings;
        plugin.syncService = new SyncService(settings);
        plugin.syncService.setCursor('cursor-1');
        plugin.syncService.loadTaskFileMap({ 42: 'Clippings/42.md' });
        plugin.syncService.loadPendingTaskIds([51]);
        plugin.syncAckQueue = new SyncAckQueue(async () => plugin.persistSyncState(), async () => 'accepted');
        plugin.syncAckQueue.load([{ taskId: 42, ackToken: 'signed-token', imagesProcessed: 1, imagesFailed: 0 }]);
        Object.assign(plugin, { persistenceQueue: Promise.resolve() });

        let releaseFirst!: () => void;
        const firstWriteGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let firstStarted!: () => void;
        const firstStartedGate = new Promise<void>(resolve => { firstStarted = resolve; });
        let writes = 0;
        let saved: Record<string, unknown> = {};
        plugin.saveData = vi.fn(async (value: Record<string, unknown>) => {
            writes += 1;
            if (writes === 1) {
                firstStarted();
                await firstWriteGate;
            }
            saved = structuredClone(value);
        });
        plugin.backupConfig = vi.fn(async () => undefined);
        plugin.startSyncInterval = vi.fn();
        Object.assign(plugin, { startAckRetryInterval: vi.fn() });

        const stateWrite = plugin.persistSyncState();
        await firstStartedGate;
        plugin.syncService.setCursor('cursor-2');
        plugin.settings.targetFolder = 'Updated';
        const settingsWrite = plugin.saveSettings();
        releaseFirst();
        await Promise.all([stateWrite, settingsWrite]);

        expect(writes).toBe(2);
        expect(saved).toMatchObject({
            targetFolder: 'Updated', cursor: 'cursor-2',
            taskFileMap: { 42: 'Clippings/42.md' }, pendingTaskIds: [51],
            pendingAcks: [{ taskId: 42, ackToken: 'signed-token', imagesProcessed: 1, imagesFailed: 0 }],
        });
    });

    it('retries durable receipts even when regular sync is set to manual only', async () => {
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
        plugin.settings = { apiKey: 'api-key', syncInterval: 0 } as BijiSyncSettings;
        const flush = vi.fn(async () => undefined);
        const setInterval = vi.fn(() => 77);
        Object.assign(plugin, {
            appVisible: true,
            timers: { clearInterval: vi.fn(), setInterval },
            syncAckQueue: { snapshot: () => [{ taskId: 42 }], flush },
        });

        plugin['startAckRetryInterval']();
        expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 300000, 'network');
        plugin['retryPendingAcks']();
        expect(flush).toHaveBeenCalledTimes(1);
    });
});
