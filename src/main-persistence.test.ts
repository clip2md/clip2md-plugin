import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings } from './settings';
import { SyncService } from './sync';
import { SyncAckQueue } from './sync-ack';

describe('plugin state persistence', () => {
    it('keeps two devices independent when they share one data.json writer', async () => {
        let shared: Record<string, unknown> = {};
        function device(id: string, key: string, cursor: string) {
            const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
            plugin.settings = plugin['normalizeSettings']({
                apiKey: key, installationId: id, targetFolder: 'Clip2MD', syncInterval: 0,
            });
            plugin.syncService = new SyncService(plugin.settings);
            plugin.syncService.setCursor(cursor);
            plugin.syncService.loadTaskFileMap({ 42: `${id}/42.md` });
            let local: Record<string, unknown> = {};
            const secrets = new Map<string, string>();
            Object.assign(plugin, {
                persistenceQueue: Promise.resolve(),
                localState: {
                    version: 1, installationId: id, cursor: null, taskFileMap: {}, pendingTaskIds: [],
                    ignoredTaskIds: [], pendingAcks: [], restoreMissingMappedTasksOnNextSync: false,
                    unresolvedTaskIds: [], legacyKeyMigrated: false,
                },
                syncAckQueue: { snapshot: () => [] },
                app: {
                    loadLocalStorage: () => local,
                    saveLocalStorage: (_key: string, value: Record<string, unknown>) => { local = structuredClone(value); },
                    secretStorage: {
                        getSecret: (name: string) => secrets.get(name) ?? null,
                        setSecret: (name: string, value: string) => { secrets.set(name, value); },
                    },
                },
                saveData: vi.fn(async (value: Record<string, unknown>) => { shared = structuredClone(value); }),
                backupConfig: vi.fn(async () => undefined),
                startSyncInterval: vi.fn(), startAckRetryInterval: vi.fn(),
            });
            return { plugin, local: () => local, secrets };
        }
        const laptop = device('laptop', 'laptop-key', 'laptop-cursor');
        const desktop = device('desktop', 'desktop-key', 'desktop-cursor');
        await laptop.plugin.saveSettings();
        await desktop.plugin.saveSettings();
        expect(laptop.local()).toMatchObject({ installationId: 'laptop', cursor: 'laptop-cursor', taskFileMap: { 42: 'laptop/42.md' } });
        expect(desktop.local()).toMatchObject({ installationId: 'desktop', cursor: 'desktop-cursor', taskFileMap: { 42: 'desktop/42.md' } });
        expect(laptop.secrets.get('clip2md-api-key')).toBe('laptop-key');
        expect(desktop.secrets.get('clip2md-api-key')).toBe('desktop-key');
        expect(shared).not.toHaveProperty('apiKey');
        expect(shared).not.toHaveProperty('cursor');
        expect(shared).not.toHaveProperty('taskFileMap');
    });

    it('keeps device progress and Key out of shared settings while persisting receipts', async () => {
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
        let local: Record<string, unknown> = {};
        let shared: Record<string, unknown> = {};
        const secrets = new Map<string, string>();
        Object.assign(plugin, {
            persistenceQueue: Promise.resolve(),
            localState: {
                version: 1, installationId: 'test', cursor: null, taskFileMap: {},
                pendingTaskIds: [], ignoredTaskIds: [], pendingAcks: [],
                restoreMissingMappedTasksOnNextSync: false, unresolvedTaskIds: [], legacyKeyMigrated: false,
            },
            app: {
                loadLocalStorage: () => local,
                saveLocalStorage: (_key: string, value: Record<string, unknown>) => { local = structuredClone(value); },
                secretStorage: {
                    getSecret: (id: string) => secrets.get(id) ?? null,
                    setSecret: (id: string, value: string) => { secrets.set(id, value); },
                },
            },
        });
        plugin.saveData = vi.fn(async (value: Record<string, unknown>) => { shared = structuredClone(value); });
        plugin.backupConfig = vi.fn(async () => undefined);
        plugin.startSyncInterval = vi.fn();
        Object.assign(plugin, { startAckRetryInterval: vi.fn() });

        const stateWrite = plugin.persistSyncState();
        plugin.syncService.setCursor('cursor-2');
        plugin.settings.targetFolder = 'Updated';
        const settingsWrite = plugin.saveSettings();
        await Promise.all([stateWrite, settingsWrite]);

        expect(local).toMatchObject({
            cursor: 'cursor-2',
            taskFileMap: { 42: 'Clippings/42.md' }, pendingTaskIds: [51],
            pendingAcks: [{ taskId: 42, ackToken: 'signed-token', imagesProcessed: 1, imagesFailed: 0 }],
        });
        expect(shared).toMatchObject({ targetFolder: 'Updated' });
        expect(shared).not.toHaveProperty('cursor');
        expect(shared).not.toHaveProperty('apiKey');
        expect(secrets.get('clip2md-api-key')).toBe('api-key');
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
