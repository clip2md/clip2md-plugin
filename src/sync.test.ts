import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { SyncService, type SyncTask } from './sync';
import { DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings } from './settings';

const requestUrlMock = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => {
    class Stub {}
    return {
        requestUrl: requestUrlMock,
        App: Stub,
        FuzzySuggestModal: Stub,
        Modal: Stub,
        Notice: Stub,
        PluginSettingTab: Stub,
        Setting: Stub,
        TAbstractFile: Stub,
        TFile: Stub,
        TFolder: Stub,
    };
});

const makeSettings = (overrides: Partial<BijiSyncSettings> = {}): BijiSyncSettings => ({
    apiKey: 'clip2md_test',
    syncInterval: 60,
    syncOnStart: true,
    targetFolder: 'Clippings',
    filenameTemplate: '{{created_date}}-{{title}}',
    filenameDateFormat: 'yyyy-MM-dd',
    template: '{{content}}',
    frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
    syncContentMode: 'full',
    imageMode: 'local',
    mergeMode: 'none',
    ...overrides,
});

const makeTask = (overrides: Partial<SyncTask> = {}): SyncTask => ({
    id: 101,
    url: 'https://example.com/post',
    status: 'SUCCESS',
    title: 'Test Title',
    summary: 'summary',
    note_markdown_content: '## Note\n\nhello',
    source_markdown_content: '# Source\n\nworld',
    note_content_version: 1,
    source_content_version: 1,
    source_date: '2026-08-07T10:00:00Z',
    duration_seconds: 300,
    content_type: 'article',
    content_source: 'wechat',
    asset_count: 0,
    asset_ready_count: 0,
    asset_pending_count: 0,
    asset_failed_count: 0,
    assets_updated_at: null,
    created_at: '2026-08-08T09:00:00Z',
    updated_at: '2026-08-08T09:00:00Z',
    source_title: 'Source title',
    source_description: 'Source description',
    tags: [],
    ...overrides,
});

class FakeVault {
    private files = new Map<string, string | ArrayBuffer>();

    private file(path: string): TFile {
        return Object.assign(new TFile(), { path });
    }

    getAbstractFileByPath(path: string) {
        return this.files.has(path) ? this.file(path) : null;
    }

    getFileByPath(path: string) {
        return this.files.has(path) ? this.file(path) : null;
    }

    async createFolder(path: string) {
        this.files.set(path, '');
    }

    async create(path: string, content: string) {
        this.files.set(path, content);
    }

    async createBinary(path: string, bytes: ArrayBuffer) {
        this.files.set(path, bytes);
    }

    async read(file: TFile) {
        return String(this.files.get(file.path) || '');
    }

    async modify(file: TFile, content: string) {
        this.files.set(file.path, content);
    }

    async rename(file: TFile, nextPath: string) {
        const value = this.files.get(file.path);
        this.files.delete(file.path);
        this.files.set(nextPath, value || '');
    }

    content(path: string) {
        return this.files.get(path);
    }
}

describe('SyncService', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        requestUrlMock.mockReset();
    });

    it('rejects path traversal and keeps preview fallback paths safe', () => {
        const service = new SyncService(makeSettings({
            targetFolder: 'Clippings/{{source}}/../bad',
            filenameTemplate: '{{created_date}}/{{title}}',
        }));

        expect(service.validateTargetFolder('Clippings/../bad')).toBe(false);
        const preview = service.getTemplatePreviewData();
        expect(preview.folder).toBe('Clippings/微信公众号/bad');
        expect(preview.filename).toBe('Clip2MD 使用示例.md');
    });

    it('marks missing pending tasks so caller can remove them', async () => {
        const service = new SyncService(makeSettings());
        service.loadPendingTaskIds([7]);

        requestUrlMock.mockResolvedValue({
            status: 404,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
        });

        await expect(service.fetchPendingTasks()).resolves.toEqual([
            { taskId: 7, task: null, missing: true },
        ]);
    });

    it('fetches paged tasks without mixing in pending items', async () => {
        const service = new SyncService(makeSettings());

        requestUrlMock.mockResolvedValue({
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {
                items: [
                    makeTask({ id: 1 }),
                    makeTask({ id: 2, note_markdown_content: null, source_markdown_content: null }),
                ],
                total: 2,
                next_cursor: 'cursor-2',
                has_more: true,
            },
        });

        await expect(service.fetchNextPage('cursor-1')).resolves.toEqual({
            tasks: [expect.objectContaining({ id: 1 })],
            total: 2,
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://api.clip2md.cn/api/v1/sync/tasks?limit=100&cursor=cursor-1',
            headers: { 'X-API-Key': 'clip2md_test' },
            throw: false,
        }));
    });

    it('keeps daily merge idempotent and preserves surrounding content', async () => {
        const service = new SyncService(makeSettings({
            mergeMode: 'daily',
            targetFolder: 'Clippings',
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();
        const task = makeTask({ id: 88, title: 'Morning Note' });

        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        const mergedPath = 'Clippings/2026-08-08-微信公众号.md';
        await vault.modify(Object.assign(new TFile(), { path: mergedPath }), `${String(vault.content(mergedPath))}\n\n用户手写内容\n`);
        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');

        const content = String(vault.content(mergedPath));
        expect(content.match(/clip2md-task-start:88/g)?.length).toBe(1);
        expect(content).toContain('用户手写内容');
    });

    it('includes tags in the default frontmatter template as a YAML list', async () => {
        const service = new SyncService(makeSettings({
            frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();
        const task = makeTask({
            id: 109,
            tags: [
                { id: 1, name: '示例', source: 'USER', upstream_type: 'manual' },
                { id: 2, name: '含"引号', source: 'AI', upstream_type: 'topic' },
            ],
        });

        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');

        const filepath = service.getTaskFileMap()[task.id];
        expect(filepath).toBeTruthy();
        const content = String(vault.content(filepath));
        expect(content).toContain('tags: ["示例", "含\\"引号"]');
    });
});
