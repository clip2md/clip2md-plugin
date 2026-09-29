import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings, type SyncRunSummary } from './settings';
import { type SyncTask } from './sync';

function testPlugin(tasks: SyncTask[], renderToVault: ReturnType<typeof vi.fn>) {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    const notice = { setMessage: vi.fn(), hide: vi.fn() };
    const enqueue = vi.fn(async () => undefined);
    plugin.settings = {
        apiKey: 'api-key', installationId: 'test', settingsSchemaVersion: 3,
        syncInterval: 60, syncOnStart: false, preventReimportAfterLocalRemoval: false, targetFolder: 'Clippings',
        filenameTemplate: '{{title}}', filenameDateFormat: 'yyyy-MM-dd',
        template: '{{content}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
        syncContentMode: 'full', imageMode: 'local', imageFolder: '',
        mergeMode: 'none',
    } as BijiSyncSettings;
    Object.assign(plugin, {
        app: { vault: {} }, syncing: false, connectionState: 'configured',
        syncAckQueue: { snapshot: () => [], enqueue, remove: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) },
        syncService: {
            fetchPendingTasks: async () => [], fetchIgnoredTasks: async () => [], getCursor: () => null, setCursor: vi.fn(),
            markIgnored: vi.fn(),
            fetchNextPage: async () => ({ tasks, total: tasks.length, nextCursor: 'done', hasMore: false }),
            renderToVault, markPending: vi.fn(), markComplete: vi.fn(),
        },
        updateRibbonState: vi.fn(), updateViewActions: vi.fn(), refreshSettingTab: vi.fn(),
        updateSyncProgress: vi.fn(), persistSyncState: vi.fn(async () => undefined),
        saveSettings: vi.fn(async () => undefined),
        startSyncProgressNotice: vi.fn(() => { Object.assign(plugin, { syncNotice: notice }); }),
        timers: { setTimeout: vi.fn() },
    });
    return { plugin, notice, enqueue };
}

const task = {
    id: 42, status: 'SUCCESS', ack_token: 'signed-token',
    asset_count: 1, asset_ready_count: 1, asset_pending_count: 0, asset_failed_count: 0,
} as SyncTask;

describe('local deletion receipt feedback', () => {
    it('counts intentional local ignores as success without retries or receipts', async () => {
        const { plugin, notice, enqueue } = testPlugin([task], vi.fn(async () => ({
            filepath: null, skipped: true, ignoredLocally: true,
        })));
        plugin.settings.preventReimportAfterLocalRemoval = true;
        const summary = await plugin.syncNow();
        expect(summary).toMatchObject({ outcome: 'success', ignored: 1, skipped: 0, pending: 0, ackBlockedCount: 0 });
        expect(plugin.syncService.markPending).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(plugin.syncAckQueue.remove).toHaveBeenCalledWith(42);
        expect(notice.setMessage).toHaveBeenCalledWith(expect.stringContaining('1 篇主动忽略'));
    });

    it('summarizes all withheld receipts in one completion notice and persists the reasons', async () => {
        const render = vi.fn(async () => ({ filepath: 'Clippings/task.md', skipped: false, unlocalizedImages: true }));
        const { plugin, notice, enqueue } = testPlugin([task, { ...task, id: 43 }], render);

        const summary = await plugin.syncNow();

        expect(summary).toMatchObject({
            outcome: 'partial', succeeded: 2, ackBlockedCount: 2,
            ackBlockedReasons: ['部分图片未保存到 Vault'],
        });
        expect(plugin.settings.lastSyncSummary).toEqual(summary);
        expect(enqueue).not.toHaveBeenCalled();
        expect(notice.setMessage).toHaveBeenCalledTimes(1);
        expect(notice.setMessage).toHaveBeenCalledWith(expect.stringContaining('2 篇未发送删除回执：部分图片未保存到 Vault'));
        expect(plugin.getStatusSnapshot().description).toContain('2 篇未发送删除回执：部分图片未保存到 Vault');
        expect(plugin.timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 8000, 'notice');
    });

    it('explains a failed Vault write without enqueueing a partial receipt', async () => {
        const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { plugin, notice, enqueue } = testPlugin([task], vi.fn(async () => { throw new Error('disk full'); }));
        const summary = await plugin.syncNow();

        expect(summary).toMatchObject({ outcome: 'partial', pending: 1, ackBlockedCount: 1, ackBlockedReasons: ['Vault 文件未写入'] });
        expect(enqueue).not.toHaveBeenCalled();
        expect(notice.setMessage).toHaveBeenCalledWith(expect.stringContaining('Vault 文件未写入'));
        warning.mockRestore();
    });

    it('shows stored feedback after restart and accepts summaries from older versions', () => {
        const { plugin } = testPlugin([], vi.fn());
        const summary: SyncRunSummary = {
            startedAt: '2026-09-28T01:00:00Z', finishedAt: '2026-09-28T01:01:00Z',
            trigger: 'manual', outcome: 'partial', pages: 1, processed: 1, succeeded: 1,
            pending: 0, skipped: 0, failed: 0, ackBlockedCount: 1,
            ackBlockedReasons: ['同步内容未选择“完整内容”'],
        };
        plugin.settings.lastSyncSummary = summary;
        expect(plugin.getStatusSnapshot().description).toContain('1 篇未发送删除回执：同步内容未选择“完整内容”');
        expect(plugin['normalizeSettings']({ ...plugin.settings, lastSyncSummary: summary }).lastSyncSummary).toEqual(summary);
        const { ackBlockedCount: _count, ackBlockedReasons: _reasons, ...oldSummary } = summary;
        expect(plugin['normalizeSettings']({ ...plugin.settings, lastSyncSummary: oldSummary }).lastSyncSummary).toEqual(oldSummary);
    });

    it('keeps ordinary sync completion unchanged when no deletion token was issued', async () => {
        const { plugin, notice, enqueue } = testPlugin([{ ...task, ack_token: null }], vi.fn(async () => ({
            filepath: 'Clippings/task.md', skipped: false, unlocalizedImages: true,
        })));
        const summary = await plugin.syncNow();
        expect(summary).toMatchObject({ outcome: 'success', ackBlockedCount: 0, ackBlockedReasons: [] });
        expect(enqueue).not.toHaveBeenCalled();
        expect(notice.setMessage).toHaveBeenCalledWith('■ ■ ■ ■ ■  同步完成！1 篇文章');
        expect(plugin.getStatusSnapshot().description).not.toContain('未发送删除回执');
    });
});
