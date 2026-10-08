import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TFile } from 'obsidian';
import BijiSyncPlugin from './main';
import { SyncService, type SyncTask } from './sync';
import { SyncAckQueue } from './sync-ack';
import { sha256 } from './saved-sync-proof';

const request = vi.hoisted(() => vi.fn());
const askSubset = vi.hoisted(() => vi.fn(() => true));
vi.mock('obsidian', async original => ({ ...await original<Record<string, unknown>>(), requestUrl: request }));
vi.mock('./subset-delete-modal', () => ({ SubsetDeleteModal: class {
    constructor(_app: unknown, _mode: unknown, private readonly resolve: (accepted: boolean) => void) {}
    open() { this.resolve(askSubset()); }
} }));

function fixture() {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    plugin.settings = plugin['normalizeSettings']({ apiKey: 'test-only', targetFolder: 'Clippings', syncInterval: 0, syncOnStart: false });
    plugin.syncService = new SyncService(plugin.settings);
    const files = new Map<string, string>();
    const vault = {
        getFileByPath: (path: string) => files.has(path) ? Object.assign(new TFile(), { path }) : null,
        getAbstractFileByPath: (path: string) => files.has(path) ? Object.assign(new TFile(), { path }) : null,
        read: vi.fn(async (file: TFile) => files.get(file.path)!),
        createFolder: async () => undefined,
        create: vi.fn(async (path: string, content: string) => { files.set(path, content); }),
        modify: async (file: TFile, content: string) => { files.set(file.path, content); },
        rename: async (file: TFile, path: string) => { files.set(path, files.get(file.path)!); files.delete(file.path); },
    };
    let saved: Record<string, unknown> = {};
    let localSaved: Record<string, unknown> = {};
    const secrets = new Map<string, string>([['clip2md-api-key', 'test-only']]);
    Object.assign(plugin, {
        app: {
            vault,
            loadLocalStorage: () => localSaved,
            saveLocalStorage: (_key: string, value: Record<string, unknown>) => { localSaved = structuredClone(value); },
            secretStorage: {
                getSecret: (id: string) => secrets.get(id) ?? null,
                setSecret: (id: string, value: string) => { secrets.set(id, value); },
            },
        }, syncing: false, syncWriteInProgress: false, appVisible: true,
        localState: {
            version: 1, installationId: 'test', cursor: null, taskFileMap: {},
            pendingTaskIds: [], ignoredTaskIds: [], pendingAcks: [],
            restoreMissingMappedTasksOnNextSync: false, unresolvedTaskIds: [], legacyKeyMigrated: false,
        },
        restoreMissingMappedTasksOnNextSync: false, persistenceQueue: Promise.resolve(),
        saveData: vi.fn(async (value: Record<string, unknown>) => { saved = structuredClone(value); }),
        backupConfig: vi.fn(async () => undefined),
        startSyncInterval: vi.fn(), startAckRetryInterval: vi.fn(),
        updateRibbonState: vi.fn(), updateViewActions: vi.fn(), refreshSettingTab: vi.fn(),
        updateSyncProgress: vi.fn(), startSyncProgressNotice: vi.fn(),
    });
    plugin.syncAckQueue = new SyncAckQueue(() => plugin.persistSyncState(), ack => plugin['deliverSyncAck'](ack));
    const task = { ...plugin.syncService.createPreviewTask(), id: 42, ack_token: null };
    const tasks = new Map<number, SyncTask>([[42, task]]);
    let page: SyncTask[] = [task];
    const fetchIds = vi.spyOn(plugin.syncService, 'fetchTasksByIds').mockImplementation(async ids =>
        ids.map(taskId => ({ taskId, task: tasks.get(taskId) ?? null, missing: !tasks.has(taskId) })));
    vi.spyOn(plugin.syncService, 'fetchNextPage').mockImplementation(async () => ({
        tasks: page, total: page.length, nextCursor: 'cursor-done', hasMore: false,
    }));
    return { plugin, files, vault, task, tasks, fetchIds, saved: () => ({ ...saved, ...localSaved }), shared: () => saved, setPage: (items: SyncTask[]) => { page = items; } };
}

beforeEach(() => {
    request.mockReset(); request.mockResolvedValue({ status: 200 });
    askSubset.mockReset(); askSubset.mockReturnValue(true);
    vi.stubGlobal('crypto', webcrypto);
});

describe('Vault local removal lifecycle', () => {
    it('defaults off, persists the setting and ignored IDs, and restores on next sync without a server delta', async () => {
        const f = fixture();
        expect(f.plugin.settings.preventReimportAfterLocalRemoval).toBe(false);
        await f.plugin.setPreventReimportAfterLocalRemoval(true);
        await f.plugin.syncNow();
        const path = f.plugin.syncService.getTaskFileMap()[42];
        f.files.delete(path);
        expect(await f.plugin.syncNow()).toMatchObject({ outcome: 'success', ignored: 1, pending: 0 });
        expect(f.saved()).toMatchObject({ preventReimportAfterLocalRemoval: true, ignoredTaskIds: [42] });
        const restarted = new SyncService(f.plugin.settings);
        restarted.loadTaskFileMap(f.saved().taskFileMap as Record<number, string>);
        restarted.loadIgnoredTaskIds(f.saved().ignoredTaskIds as number[]);
        expect(restarted.getIgnoredTaskIds()).toEqual([42]);
        await f.plugin.setPreventReimportAfterLocalRemoval(false);
        f.setPage([]);
        expect(await f.plugin.syncNow()).toMatchObject({ succeeded: 1, ignored: 0 });
        expect(f.fetchIds).toHaveBeenCalledWith([42]);
        expect(f.files.get(path)).toBeTruthy();
        expect(f.saved().ignoredTaskIds).toEqual([]);
    });

    it('restores a file removed before the next sync and survives toggling off and immediately on', async () => {
        const f = fixture();
        await f.plugin.setPreventReimportAfterLocalRemoval(true);
        await f.plugin.syncNow();
        const path = f.plugin.syncService.getTaskFileMap()[42];
        f.files.delete(path);
        f.setPage([]);
        await f.plugin.setPreventReimportAfterLocalRemoval(false);
        await f.plugin.setPreventReimportAfterLocalRemoval(true);
        await f.plugin.syncNow();
        expect(f.files.has(path)).toBe(false);
        await f.plugin.setPreventReimportAfterLocalRemoval(false);
        await f.plugin.syncNow();
        expect(f.files.has(path)).toBe(true);
    });

    it('cleans unavailable restore candidates instead of repeatedly fetching them', async () => {
        const f = fixture();
        f.plugin.syncService.markIgnored(42);
        f.tasks.delete(42);
        f.setPage([]);
        await f.plugin.syncNow();
        expect(f.plugin.syncService.getIgnoredTaskIds()).toEqual([]);
        await f.plugin.syncNow();
        expect(f.fetchIds.mock.calls.filter(([ids]) => ids.includes(42))).toHaveLength(1);
    });

    it('keeps ignored tasks out of retries when resetting the cursor replays old tasks', async () => {
        const f = fixture();
        await f.plugin.setPreventReimportAfterLocalRemoval(true);
        await f.plugin.syncNow();
        const path = f.plugin.syncService.getTaskFileMap()[42];
        f.files.delete(path);
        f.plugin.syncService.markPending(42);
        expect(await f.plugin.syncNow()).toMatchObject({ ignored: 1, pending: 0, outcome: 'success' });
        f.plugin.syncService.setCursor(null);
        f.plugin.syncService.markPending(42);
        expect(await f.plugin.syncNow()).toMatchObject({ ignored: 1, succeeded: 0, pending: 0 });
        expect(f.plugin.syncService.getPendingTaskIds()).toEqual([]);
        expect(f.files.has(path)).toBe(false);
        expect(request).not.toHaveBeenCalled();
    });

    it('retains restoration after failed writes and aborts without advancing the cursor on network errors', async () => {
        const f = fixture();
        f.plugin.syncService.markIgnored(42);
        f.setPage([]);
        f.vault.create.mockRejectedValueOnce(new Error('disk full'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await f.plugin.syncNow()).toMatchObject({ pending: 1 });
        expect(f.plugin.syncService.getIgnoredTaskIds()).toEqual([42]);
        f.fetchIds.mockRejectedValueOnce(new Error('offline'));
        const cursor = f.plugin.syncService.getCursor();
        expect(await f.plugin.syncNow()).toMatchObject({ outcome: 'failed' });
        expect(f.plugin.syncService.getCursor()).toBe(cursor);
        expect(f.plugin.syncService.getIgnoredTaskIds()).toEqual([42]);
        await f.plugin.syncNow();
        expect(f.plugin.syncService.getIgnoredTaskIds()).toEqual([]);
        vi.restoreAllMocks();
    });
});

describe('receipt preflight against the actual Vault mapping', () => {
    const ack = { taskId: 42, ackToken: 'test-token', imagesProcessed: 0, imagesFailed: 0 };

    it.each(['mode', 'content', 'imageMode'] as const)('discards a v2 receipt when %s changes before retry', async changed => {
        const f = fixture();
        await f.plugin.syncNow();
        const filepath = f.plugin.syncService.getTaskFileMap()[42];
        const v2 = { ...ack, scopeVersion: 2 as const, contentMode: 'full' as const, processedAssetIds: [],
            savedProof: { filepath, contentHash: await sha256(f.files.get(filepath)!), images: [] } };
        await f.plugin.syncAckQueue.enqueue(v2);
        if (changed === 'mode') f.plugin.settings.syncContentMode = 'source';
        else if (changed === 'imageMode') f.plugin.settings.imageMode = 'disabled';
        else f.files.set(filepath, `${f.files.get(filepath)}\nuser edit`);
        await f.plugin.syncAckQueue.flush();
        expect(request).not.toHaveBeenCalled();
        expect(f.plugin.syncAckQueue.snapshot()).toEqual([]);
        expect(f.plugin.syncService.getPendingTaskIds()).toEqual([42]);
    });

    it('persists subset consent per credential and mode only on this device', async () => {
        const f = fixture();
        f.plugin.settings.syncContentMode = 'source';
        expect(await f.plugin['confirmSubsetDelete']('source')).toBe(true);
        expect(askSubset).toHaveBeenCalledOnce();
        expect(await f.plugin['confirmSubsetDelete']('source')).toBe(true);
        expect(askSubset).toHaveBeenCalledOnce();
        expect(f.saved().subsetDeleteConsent).toEqual({ credentialFingerprint: await sha256('test-only'), modes: ['source'] });
        expect(f.shared().subsetDeleteConsent).toBeUndefined();
        f.plugin.settings.syncContentMode = 'note';
        askSubset.mockReturnValue(false);
        expect(await f.plugin['confirmSubsetDelete']('note')).toBe(false);
        expect(askSubset).toHaveBeenCalledTimes(2);
        f.plugin.settings.apiKey = 'another-device-key';
        askSubset.mockReturnValue(true);
        expect(await f.plugin['confirmSubsetDelete']('note')).toBe(true);
        expect(askSubset).toHaveBeenCalledTimes(3);
    });

    it('requires a separate image omission consent and supports full content without images', async () => {
        const f = fixture();
        f.plugin.settings.syncContentMode = 'source';
        await f.plugin['confirmSubsetDelete']('source');
        f.plugin.settings.imageMode = 'disabled';
        await f.plugin['confirmSubsetDelete']('source');
        expect(askSubset).toHaveBeenCalledTimes(2);
        expect(f.saved().imageOmissionDeleteConsent).toEqual({ credentialFingerprint: await sha256('test-only'), modes: ['source'] });
        await f.plugin['confirmSubsetDelete']('source');
        expect(askSubset).toHaveBeenCalledTimes(2);
        f.plugin.settings.syncContentMode = 'full';
        await f.plugin['confirmSubsetDelete']('full');
        expect(askSubset).toHaveBeenCalledTimes(3);
        expect(f.saved().imageOmissionDeleteConsent).toEqual({ credentialFingerprint: await sha256('test-only'), modes: ['source', 'full'] });
        expect(f.shared().imageOmissionDeleteConsent).toBeUndefined();
    });

    it.each([true, false])('discards a missing-file receipt without POST when protection is %s', async enabled => {
        const f = fixture();
        await f.plugin.setPreventReimportAfterLocalRemoval(enabled);
        await f.plugin.syncNow();
        f.files.delete(f.plugin.syncService.getTaskFileMap()[42]);
        await f.plugin.syncAckQueue.enqueue(ack);
        await f.plugin.syncAckQueue.flush();
        expect(request).not.toHaveBeenCalled();
        expect(f.plugin.syncAckQueue.snapshot()).toEqual([]);
        expect(enabled ? f.plugin.syncService.getIgnoredTaskIds() : f.plugin.syncService.getPendingTaskIds()).toEqual([42]);
    });

    it('retains a receipt when reading fails and sends only after a successful preflight', async () => {
        const f = fixture();
        await f.plugin.syncNow();
        await f.plugin.syncAckQueue.enqueue(ack);
        f.vault.read.mockRejectedValueOnce(new Error('temporary read error'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await f.plugin.syncAckQueue.flush();
        expect(request).not.toHaveBeenCalled();
        expect(f.plugin.syncAckQueue.snapshot()).toEqual([ack]);
        await f.plugin.syncAckQueue.flush();
        expect(request).toHaveBeenCalledOnce();
        expect(f.plugin.syncAckQueue.snapshot()).toEqual([]);
        warn.mockRestore();
    });

    it('pauses background receipt retries during sync writes and rejects missing markers', async () => {
        const f = fixture();
        await f.plugin.syncNow();
        await f.plugin.syncAckQueue.enqueue(ack);
        Object.assign(f.plugin, { syncing: true, syncWriteInProgress: true });
        const flush = vi.spyOn(f.plugin.syncAckQueue, 'flush');
        f.plugin['retryPendingAcks']();
        expect(flush).not.toHaveBeenCalled();
        await expect(f.plugin['deliverSyncAck'](ack)).rejects.toThrow('Vault 写入期间');
        Object.assign(f.plugin, { syncing: false, syncWriteInProgress: false });
        f.files.set(f.plugin.syncService.getTaskFileMap()[42], 'personal note without task marker');
        await f.plugin.syncAckQueue.flush();
        expect(request).not.toHaveBeenCalled();
        expect(f.plugin.syncAckQueue.snapshot()).toEqual([]);
    });
});
