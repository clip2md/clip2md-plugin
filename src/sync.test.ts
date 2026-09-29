import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { isInvalidApiKeyError, SyncRequestError, SyncService, type SyncTask } from './sync';
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
        SettingPage: Stub,
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
    imageFolder: '',
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

const pngBytes = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).buffer;

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

    async modifyBinary(file: TFile, bytes: ArrayBuffer) {
        this.files.set(file.path, bytes);
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

    paths() {
        return [...this.files.keys()];
    }
}

describe('SyncService', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        requestUrlMock.mockReset();
    });

    it('identifies only an HTTP 401 response as an invalid API Key', async () => {
        const service = new SyncService(makeSettings());
        requestUrlMock.mockResolvedValue({
            status: 401,
            headers: {},
            json: {},
        });

        const error = await service.probeConnection().catch(caught => caught);
        expect(error).toBeInstanceOf(SyncRequestError);
        expect(isInvalidApiKeyError(error)).toBe(true);
        expect(isInvalidApiKeyError(new SyncRequestError('forbidden', 403))).toBe(false);
        expect(isInvalidApiKeyError(new Error('network'))).toBe(false);
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

    it('uses a distinct source title in the body, frontmatter, filename, and folder', async () => {
        const service = new SyncService(makeSettings({
            targetFolder: 'Clippings/{{source_title}}/{{created_date}}',
            filenameTemplate: '{{source_title}}-{{title}}',
            frontmatterTemplate: '---\ntitle: "{{title}}"\nsource_title: "{{source_title}}"\ntask_id: {{task_id}}\n---',
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();
        const task = makeTask({ title: '智能笔记标题', source_title: '来源中文标题' });

        const result = await service.renderToVault(
            vault as never,
            task,
            'Clippings/{{source_title}}/{{created_date}}',
            '任务标题：{{title}}\n来源标题：{{source_title}}\n\n{{content}}',
        );

        expect(result.filepath).toBe('Clippings/来源中文标题/2026-08-08/来源中文标题-智能笔记标题.md');
        const content = String(vault.content(result.filepath!));
        expect(content).toContain('任务标题：智能笔记标题\n来源标题：来源中文标题');
        expect(content).toContain('title: "智能笔记标题"\nsource_title: "来源中文标题"');
        expect(content).not.toContain('{{source_title}}');
    });

    it('previews source-title variables separately from the task title', () => {
        const service = new SyncService(makeSettings({
            targetFolder: 'Clippings/{{source_title}}',
            filenameTemplate: '{{source_title}}-{{title}}',
        }));

        expect(service.renderTemplatePreview('{{source_title}} | {{title}}'))
            .toBe('<!-- biji-task-id:9527 -->\n\n示例原文 | Clip2MD 使用示例');
        expect(service.getTemplatePreviewData()).toEqual({
            folder: 'Clippings/示例原文',
            filename: '示例原文-Clip2MD 使用示例.md',
        });
    });

    it.each([null, ''])('renders an empty source title (%j) without falling back to the task title', async sourceTitle => {
        const service = new SyncService(makeSettings({
            targetFolder: '{{source_title}}',
            filenameTemplate: '{{source_title}}',
            frontmatterTemplate: '---\nsource_title: "{{source_title}}"\ntask_id: {{task_id}}\n---',
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();

        const result = await service.renderToVault(
            vault as never,
            makeTask({ source_title: sourceTitle }),
            '{{source_title}}',
            'title=[{{title}}]; source=[{{source_title}}]\n\n{{content}}',
        );

        expect(result.filepath).toBe('Clip2MD/untitled-101.md');
        const content = String(vault.content(result.filepath!));
        expect(content).toContain('title=[Test Title]; source=[]');
        expect(content).toContain('source_title: ""');
        expect(content).not.toContain('{{source_title}}');
    });

    it('preserves replacement syntax and token-like text and escapes source titles in frontmatter', async () => {
        const sourceTitle = '来源 $& $$ {{title}} {{source_title}} {{content}} "引号" \\路径\n第二行\t末尾';
        const title = '任务 $& $$ {{source_title}}';
        const noteContent = '## Note\n\n笔记 $& $$ {{source_title}} {{task_id}}';
        const sourceContent = '# Source\n\n原文 $& $$ {{title}}';
        const service = new SyncService(makeSettings({
            frontmatterTemplate: '---\ntitle: "{{title}}"\nsource_title: "{{source_title}}"\ntask_id: {{task_id}}\n---',
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();

        const result = await service.renderToVault(
            vault as never,
            makeTask({ title, source_title: sourceTitle, note_markdown_content: noteContent, source_markdown_content: sourceContent }),
            'Clippings',
            'title=[{{title}}]\nsource=[{{source_title}}]\nunknown={{unknown}}\n\n{{content}}',
        );

        const content = String(vault.content(result.filepath!));
        expect(content).toContain(`title=[${title}]\nsource=[${sourceTitle}]\nunknown={{unknown}}`);
        expect(content).toContain(noteContent);
        expect(content).toContain(sourceContent);
        const sourceTitleValue = content.match(/^source_title: (.+)$/m)?.[1];
        expect(sourceTitleValue).toBeDefined();
        expect(JSON.parse(sourceTitleValue!)).toBe(sourceTitle);
        expect(content.match(/^source_title: /gm)).toHaveLength(1);
        expect(content).toContain('\\n第二行\\t末尾');
    });

    it('keeps forbidden source-title characters inside one safe path segment', async () => {
        const service = new SyncService(makeSettings({
            filenameTemplate: '{{source_title}}',
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();
        const sourceTitle = '原/文\\标题:<>"|?*\n尾';
        const safeTitle = '原_文_标题________尾';

        const result = await service.renderToVault(
            vault as never,
            makeTask({ source_title: sourceTitle }),
            'Clippings/{{source_title}}/Notes',
            '{{source_title}}\n\n{{content}}',
        );

        expect(result.filepath).toBe(`Clippings/${safeTitle}/Notes/${safeTitle}.md`);
        expect(vault.paths()).toEqual([
            'Clippings',
            `Clippings/${safeTitle}`,
            `Clippings/${safeTitle}/Notes`,
            `Clippings/${safeTitle}/Notes/${safeTitle}.md`,
        ]);
        expect(String(vault.content(result.filepath!))).toContain(sourceTitle);
    });

    it('keeps long source titles within the existing filename and folder segment limit', async () => {
        const service = new SyncService(makeSettings({
            filenameTemplate: '{{source_title}}',
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();
        const sourceTitle = '长'.repeat(130);
        const safeTitle = '长'.repeat(120);

        const result = await service.renderToVault(
            vault as never,
            makeTask({ source_title: sourceTitle }),
            'Clippings/{{source_title}}',
            '{{source_title}}\n\n{{content}}',
        );

        expect(result.filepath).toBe(`Clippings/${safeTitle}/${safeTitle}.md`);
        expect(String(vault.content(result.filepath!))).toContain(sourceTitle);
    });

    it('keeps default file naming and content unchanged when the source title changes', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'disabled' }));
        const vault = new FakeVault();
        const task = makeTask({ source_title: null });
        const expectedContent = '---\ntitle: "Test Title"\ndate: "2026-08-07T10:00:00Z"\nsource: "微信公众号"\ntags: []\ntask_id: 101\n---\n\n## Note\n\nhello\n\n# 原文\n\n# Source\n\nworld';

        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        expect(first.filepath).toBe('Clippings/2026-08-08-Test Title.md');
        expect(vault.content(first.filepath!)).toBe(expectedContent);

        const second = await service.renderToVault(
            vault as never,
            { ...task, source_title: '新的来源标题' },
            'Clippings',
            '{{content}}',
        );
        expect(second.filepath).toBe(first.filepath);
        expect(vault.content(second.filepath!)).toBe(expectedContent);
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
        const task = makeTask({
            id: 88,
            title: 'Morning Note',
            source_title: '原文 $& $$ {{title}} {{task_id}}',
            note_markdown_content: '## Note\n\n笔记 $& $$ {{source_title}}',
        });
        const template = '{{source_title}}\n\n{{content}}';

        await service.renderToVault(vault as never, task, 'Clippings', template);
        const mergedPath = 'Clippings/2026-08-08-微信公众号.md';
        const contentWithManualText = `${String(vault.content(mergedPath))}\n\n用户手写内容\n`;
        await vault.modify(Object.assign(new TFile(), { path: mergedPath }), contentWithManualText);
        await service.renderToVault(vault as never, task, 'Clippings', template);
        await service.renderToVault(vault as never, task, 'Clippings', template);

        const content = String(vault.content(mergedPath));
        expect(content).toBe(contentWithManualText);
        expect(content.match(/clip2md-task-start:88/g)?.length).toBe(1);
        expect(content).toContain('用户手写内容');
        expect(content).toContain(task.source_title);
        expect(content).toContain(task.note_markdown_content);
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

    it('downloads production CDN image URLs in local image mode', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'local' }));
        const vault = new FakeVault();
        const cdnUrl = 'https://media.clip2md.cn/assets/task-101/cover.png?sign=old';
        requestUrlMock.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            arrayBuffer: pngBytes(),
        });

        const result = await service.renderToVault(
            vault as never,
            makeTask({
                note_markdown_content: `before\n\n![cover](${cdnUrl})\n\nafter`,
                source_markdown_content: null,
                asset_count: 1,
                asset_ready_count: 1,
            }),
            'Clippings',
            '{{content}}',
        );

        expect(result).toMatchObject({
            skipped: false, pendingAssets: false, failedAssets: false,
            localizedAssetCount: 1, unlocalizedImages: false,
        });
        const content = String(vault.content(service.getTaskFileMap()[101]));
        expect(content).toContain('![cover](./_assets/task-101/');
        expect(content).not.toContain('media.clip2md.cn');
        expect(requestUrlMock).toHaveBeenCalledWith({
            url: cdnUrl,
            method: 'GET',
            headers: {},
            throw: false,
        });
        expect(vault.content('Clippings/_assets/task-101')).toBe('');
    });

    it('does not classify unresolved hosted HTML images as localized assets', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'local' }));
        const vault = new FakeVault();
        const result = await service.renderToVault(vault as never, makeTask({
            note_markdown_content: '<img src="https://media.clip2md.cn/assets/task-101/cover.png">',
            source_markdown_content: null,
            asset_count: 1,
            asset_ready_count: 1,
        }), 'Clippings', '{{content}}');

        expect(result.localizedAssetCount).toBe(0);
        expect(result.unlocalizedImages).toBe(true);
        expect(requestUrlMock).not.toHaveBeenCalled();
    });

    it('keeps the source task when reference or external images remain remote', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'local' }));
        const vault = new FakeVault();
        const result = await service.renderToVault(vault as never, makeTask({
            note_markdown_content: '![cover][ref]\n\n[ref]: https://elsewhere.example/cover.png',
            source_markdown_content: null,
        }), 'Clippings', '{{content}}');

        expect(result.unlocalizedImages).toBe(true);
        expect(result.pendingAssets).toBe(false);
    });

    it('does not count a non-image response as a completed local image', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'local' }));
        const vault = new FakeVault();
        requestUrlMock.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png', 'x-asset-status': 'READY' },
            arrayBuffer: new TextEncoder().encode('<html>not an image</html>').buffer,
        });

        const result = await service.renderToVault(vault as never, makeTask({
            note_markdown_content: '![cover](https://media.clip2md.cn/assets/task-101/cover.png)',
            source_markdown_content: null,
            asset_count: 1,
            asset_ready_count: 1,
        }), 'Clippings', '{{content}}');

        expect(result).toMatchObject({ pendingAssets: true, localizedAssetCount: 0 });
        expect(vault.paths()).not.toContainEqual(expect.stringMatching(/\/task-101\/.*\.png$/));
    });

    it('stores images in a selected Vault folder and links them from the note', async () => {
        const service = new SyncService(makeSettings({ imageFolder: 'Attachments/My Images' }));
        const vault = new FakeVault();
        requestUrlMock.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            arrayBuffer: pngBytes(),
        });

        await service.renderToVault(vault as never, makeTask({
            note_markdown_content: '![cover](https://media.clip2md.cn/assets/task-101/cover.png)',
            source_markdown_content: null,
        }), 'Clippings/2026', '{{content}}');

        expect(vault.content('Attachments/My Images/task-101')).toBe('');
        expect(vault.paths()).toContainEqual(expect.stringMatching(/^Attachments\/My Images\/task-101\/.+\.png$/));
        expect(String(vault.content(service.getTaskFileMap()[101])))
            .toMatch(/!\[cover\]\(\.\.\/\.\.\/Attachments\/My%20Images\/task-101\/.+\.png\)/);
    });

    it('allows the Vault root as a selected image directory', async () => {
        const service = new SyncService(makeSettings({ imageFolder: '/' }));
        const vault = new FakeVault();
        requestUrlMock.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            arrayBuffer: pngBytes(),
        });

        await service.renderToVault(vault as never, makeTask({
            note_markdown_content: '![cover](https://media.clip2md.cn/assets/task-101/cover.png)',
            source_markdown_content: null,
        }), 'Clippings', '{{content}}');

        expect(vault.content('task-101')).toBe('');
        expect(String(vault.content(service.getTaskFileMap()[101])))
            .toMatch(/!\[cover\]\(\.\.\/task-101\/.+\.png\)/);
    });

    it('uses a stable local filename when a CDN signature changes', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'local' }));
        const vault = new FakeVault();
        requestUrlMock.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            arrayBuffer: pngBytes(),
        });

        const firstTask = makeTask({
            note_markdown_content: '![cover](https://media.clip2md.cn/assets/task-101/cover.png?sign=old)',
            source_markdown_content: null,
        });
        const secondTask = {
            ...firstTask,
            note_markdown_content: '![cover](https://media.clip2md.cn/assets/task-101/cover.png?sign=new)',
        };

        await service.renderToVault(vault as never, firstTask, 'Clippings', '{{content}}');
        const firstAssetPath = vault.paths()
            .find(path => path.startsWith('Clippings/_assets/task-101/'));
        await service.renderToVault(vault as never, secondTask, 'Clippings', '{{content}}');
        const assetPaths = vault.paths()
            .filter(path => path.startsWith('Clippings/_assets/task-101/'));

        expect(firstAssetPath).toBeTruthy();
        expect(assetPaths).toEqual([firstAssetPath]);
    });

    it('removes Markdown and HTML images without downloading in disabled image mode', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'disabled' }));
        const vault = new FakeVault();
        const task = makeTask({
            note_markdown_content: 'before\n\n![cover](https://media.clip2md.cn/assets/task-101/cover.png?sign=fresh)\n\n<img src="https://media.clip2md.cn/assets/task-101/inline.png">\n\nafter',
            source_markdown_content: 'source',
        });

        const result = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');

        const content = String(vault.content(service.getTaskFileMap()[101]));
        expect(content).toContain('before');
        expect(content).toContain('after');
        expect(content).toContain('source');
        expect(content).not.toContain('media.clip2md.cn');
        expect(content).not.toContain('![cover]');
        expect(content).not.toContain('<img');
        expect(result.unlocalizedImages).toBe(true);
        expect(requestUrlMock).not.toHaveBeenCalled();
    });
});
