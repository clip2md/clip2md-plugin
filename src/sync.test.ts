import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { isInvalidApiKeyError, SyncRequestError, SyncService, validateMarkdownBodyTemplate, type SyncTask } from './sync';
import { DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE, NEW_DEFAULT_FRONTMATTER_TEMPLATE, NEW_DEFAULT_FILENAME_TEMPLATE, type BijiSyncSettings } from './settings';
import { buildSyncAck } from './sync-ack';

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
    installationId: 'test',
    settingsSchemaVersion: 3,
    syncInterval: 60,
    syncOnStart: true,
    preventReimportAfterLocalRemoval: false,
    targetFolder: 'Clippings',
    filenameTemplate: '{{created_date}}-{{title}}',
    filenameDateFormat: 'yyyy-MM-dd',
    template: '{{content}}',
    frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
    dailyMergeFrontmatterTemplate: DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE,
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

    remove(path: string) { this.files.delete(path); }

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

    it.each(['full', 'note', 'source'] as const)('keeps frontmatter at the top in %s mode', async mode => {
        const settings = makeSettings({ syncContentMode: mode, imageMode: 'disabled' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const task = makeTask();
        const template = '# {{title}}\n\n{{content}}\n\n{{url}}';
        const result = await service.renderToVault(vault as never, task, 'Clippings', template);
        const markdown = String(vault.content(result.filepath!));
        expect(markdown).toMatch(/^---\ntitle: "Test Title"[\s\S]*?\n---\n\n<!-- biji-task-id:101 -->/);
        expect(markdown.match(/^---$/gm)).toHaveLength(2);
        expect(markdown).toContain('# Test Title');
        expect(markdown).toContain('https://example.com/post');
        expect(markdown.includes('## Note')).toBe(mode !== 'source');
        expect(markdown.includes('# Source')).toBe(mode !== 'note');
    });

    it('writes frontmatter and other fields when the body template omits content', async () => {
        const settings = makeSettings({ imageMode: 'disabled' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const template = '# {{title}}\n{{url}}';
        const task = makeTask({ ack_token: 'signed-token' });
        const result = await service.renderToVault(vault as never, task, 'Clippings', template);
        const markdown = String(vault.content(result.filepath!));
        expect(markdown).toContain('task_id: 101\n---\n\n<!-- biji-task-id:101 -->');
        expect(markdown).toContain('# Test Title\nhttps://example.com/post');
        expect(markdown).not.toContain('## Note');
        expect(buildSyncAck(task, result, { ...settings, template })).toBeNull();
    });

    it('keeps frontmatter when a full-mode task has only one content source', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'disabled' }));
        const vault = new FakeVault();
        const result = await service.renderToVault(vault as never,
            makeTask({ note_markdown_content: null }), 'Clippings', '{{content}}');
        expect(String(vault.content(result.filepath!))).toMatch(/^---\ntitle: /);
        expect(String(vault.content(result.filepath!))).toContain('# Source');
    });

    it('updates an old single note that has a task ID only in frontmatter', async () => {
        const service = new SyncService(makeSettings({ imageMode: 'disabled' }));
        const vault = new FakeVault();
        const filepath = 'Clippings/2026-08-08-Test Title.md';
        await vault.create(filepath, '---\ntask_id: 101\n---\n\n旧正文');
        service.loadTaskFileMap({ 101: filepath });
        const result = await service.renderToVault(vault as never, makeTask(), 'Clippings', '{{content}}');
        expect(result.filepath).toBe(filepath);
        expect(String(vault.content(filepath))).toContain('<!-- biji-task-id:101 -->');
        expect(String(vault.content(filepath))).not.toContain('旧正文');
    });

    it('uses the same composed output for preview and Vault writes', async () => {
        const settings = makeSettings({ imageMode: 'disabled' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const preview = service.createPreviewTask();
        const result = await service.renderToVault(vault as never, preview, 'Clippings', settings.template);
        expect(vault.content(result.filepath!)).toBe(service.renderTemplatePreview(settings.template));
    });

    it('rejects a body frontmatter before creating a Vault file, but allows later separators', async () => {
        const service = new SyncService(makeSettings());
        const vault = new FakeVault();
        const yaml = '---\ntitle: duplicate\n---\n{{content}}';
        expect(service.validateTemplate(yaml)).toMatchObject({ valid: false });
        expect(validateMarkdownBodyTemplate('')).toMatchObject({ valid: false });
        expect(validateMarkdownBodyTemplate('正文\n---\n分隔')).toMatchObject({ valid: true });
        await expect(service.renderToVault(vault as never, makeTask(), 'Clippings', yaml))
            .rejects.toThrow('请将 YAML 移到前置元数据模板');
        expect(vault.paths()).toEqual([]);
    });

    it.each(['delete', 'rename', 'move'])('ignores a local %s before downloading images and keeps the decision after restart', async action => {
        const settings = makeSettings({ preventReimportAfterLocalRemoval: true });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const task = makeTask();
        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        if (action === 'delete') vault.remove(first.filepath!);
        else await vault.rename(vault.getFileByPath(first.filepath!)!, `Personal/${action}.md`);
        service.markPending(task.id);
        const withImage = { ...task, note_markdown_content: '![image](https://media.clip2md.cn/assets/test.png)' };
        const result = await service.renderToVault(vault as never, withImage, 'Clippings', '{{content}}');
        expect(result.ignoredLocally).toBe(true);
        expect(vault.getFileByPath(first.filepath!)).toBeNull();
        expect(requestUrlMock).not.toHaveBeenCalled();
        expect(service.getPendingTaskIds()).toEqual([]);
        const restarted = new SyncService(settings);
        restarted.loadTaskFileMap({ ...service.getTaskFileMap() });
        restarted.loadIgnoredTaskIds(service.getIgnoredTaskIds());
        expect((await restarted.renderToVault(vault as never, task, 'Clippings', '{{content}}')).ignoredLocally).toBe(true);
        if (action !== 'delete') expect(vault.content(`Personal/${action}.md`)).toBeTruthy();
    });

    it('keeps normal updates and plugin-driven renames and accepts a new task with the same URL', async () => {
        const service = new SyncService(makeSettings({ preventReimportAfterLocalRemoval: true }));
        const vault = new FakeVault();
        const task = makeTask();
        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        const updated = await service.renderToVault(vault as never, { ...task, title: 'Updated', note_markdown_content: 'new content' }, 'Clippings', '{{content}}');
        expect(updated.ignoredLocally).toBeUndefined();
        expect(vault.content(updated.filepath!)).toContain('new content');
        expect(vault.getFileByPath(first.filepath!)).toBeNull();
        vault.remove(updated.filepath!);
        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        const fresh = await service.renderToVault(vault as never, { ...task, id: 102 }, 'Clippings', '{{content}}');
        expect(fresh.filepath).toBeTruthy();
        expect(service.getIgnoredTaskIds()).toEqual([101]);
    });

    it('restores ignored articles to a safe path when disabled and retries a failed write', async () => {
        const settings = makeSettings({ preventReimportAfterLocalRemoval: true });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const task = makeTask();
        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        vault.remove(first.filepath!);
        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        settings.preventReimportAfterLocalRemoval = false;
        await vault.create(first.filepath!, 'personal content');
        vi.spyOn(vault, 'create').mockRejectedValueOnce(new Error('disk full'));
        await expect(service.renderToVault(vault as never, task, 'Clippings', '{{content}}')).rejects.toThrow('disk full');
        expect(service.getIgnoredTaskIds()).toEqual([101]);
        const restored = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        expect(restored.filepath).toBe('Clippings/2026-08-08-Test Title 2.md');
        expect(vault.content(first.filepath!)).toBe('personal content');
        expect(service.getIgnoredTaskIds()).toEqual([]);
    });

    it('does not permanently ignore a temporary Vault read failure', async () => {
        const service = new SyncService(makeSettings({ preventReimportAfterLocalRemoval: true }));
        const vault = new FakeVault();
        const task = makeTask();
        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        vi.spyOn(vault, 'read').mockRejectedValueOnce(new Error('read failed'));
        await expect(service.renderToVault(vault as never, task, 'Clippings', '{{content}}')).rejects.toThrow('read failed');
        expect(service.getIgnoredTaskIds()).toEqual([]);
    });

    it('does not reinsert removed daily blocks even when a new task recreates the shared file first', async () => {
        const settings = makeSettings({ preventReimportAfterLocalRemoval: true, mergeMode: 'daily' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const task = makeTask();
        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        vault.remove(first.filepath!);
        await service.renderToVault(vault as never, { ...task, id: 102 }, 'Clippings', '{{content}}');
        expect((await service.renderToVault(vault as never, task, 'Clippings', '{{content}}')).ignoredLocally).toBe(true);
        expect(vault.content(first.filepath!)).not.toContain('clip2md-task-start:101');
        expect(vault.content(first.filepath!)).toContain('clip2md-task-start:102');
        settings.preventReimportAfterLocalRemoval = false;
        await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        expect(vault.content(first.filepath!)).toContain('clip2md-task-start:101');
        expect(vault.content(first.filepath!)).toContain('clip2md-task-start:102');
    });

    it('detects deletion of one daily block while retaining other tasks', async () => {
        const service = new SyncService(makeSettings({ preventReimportAfterLocalRemoval: true, mergeMode: 'daily' }));
        const vault = new FakeVault();
        const task = makeTask();
        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        await service.renderToVault(vault as never, { ...task, id: 102 }, 'Clippings', '{{content}}');
        await vault.modify(vault.getFileByPath(first.filepath!)!, String(vault.content(first.filepath!))
            .replace(/<!-- clip2md-task-start:101 -->[\s\S]*?<!-- clip2md-task-end:101 -->/, ''));
        expect((await service.renderToVault(vault as never, task, 'Clippings', '{{content}}')).ignoredLocally).toBe(true);
        expect((await service.renderToVault(vault as never, { ...task, id: 102 }, 'Clippings', '{{content}}')).skipped).toBe(false);
    });

    it('keeps legacy rebuilding when the switch is off', async () => {
        const service = new SyncService(makeSettings());
        const vault = new FakeVault();
        const task = makeTask();
        const first = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        vault.remove(first.filepath!);
        expect((await service.renderToVault(vault as never, task, 'Clippings', '{{content}}')).filepath).toBe(first.filepath);
    });

    it('restores a daily task beside an unrelated file without overwriting it', async () => {
        const settings = makeSettings({ mergeMode: 'daily' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        service.markIgnored(101);
        await vault.create('Clippings/2026-08-08-微信公众号.md', 'personal daily journal');
        const result = await service.renderToVault(vault as never, makeTask(), 'Clippings', '{{content}}');
        expect(result.filepath).toBe('Clippings/2026-08-08-微信公众号 2.md');
        expect(vault.content('Clippings/2026-08-08-微信公众号.md')).toBe('personal daily journal');
    });

    it('limits targeted restoration requests to five in flight', async () => {
        const service = new SyncService(makeSettings());
        service.loadIgnoredTaskIds(Array.from({ length: 12 }, (_, index) => index + 1));
        let inflight = 0;
        let peak = 0;
        requestUrlMock.mockImplementation(async () => {
            inflight += 1;
            peak = Math.max(peak, inflight);
            await Promise.resolve();
            inflight -= 1;
            return { status: 404 };
        });
        expect(await service.fetchIgnoredTasks()).toHaveLength(12);
        expect(peak).toBe(5);
        expect(requestUrlMock).toHaveBeenCalledTimes(12);
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
            '智能标题：{{title}}\n来源标题：{{source_title}}\n\n{{content}}',
        );

        expect(result.filepath).toBe('Clippings/来源中文标题/2026-08-08/来源中文标题-智能笔记标题.md');
        const content = String(vault.content(result.filepath!));
        expect(content).toContain('智能标题：智能笔记标题\n来源标题：来源中文标题');
        expect(content).toContain('title: "智能笔记标题"\nsource_title: "来源中文标题"');
        expect(content).not.toContain('{{source_title}}');
    });

    it.each([
        ['website', '网站标题'], ['source', '原始标题'], ['task', '智能标题'], ['custom', '原始标题 · 101'],
    ] as const)('uses %s titles consistently in files, properties, body and daily task lists', async (titleMode, expected) => {
        const settings = makeSettings({ titleMode, customTitleTemplate: '{{source_title}} · {{task_id}}',
            filenameTemplate: NEW_DEFAULT_FILENAME_TEMPLATE, frontmatterTemplate: NEW_DEFAULT_FRONTMATTER_TEMPLATE, imageMode: 'disabled' });
        const service = new SyncService(settings);
        const task = makeTask({ title: '智能标题', source_title: '原始标题', display_title: '网站标题' });
        const vault = new FakeVault();
        const single = await service.renderToVault(vault as never, task, 'Clippings', '# {{note_title}}\n{{title}}\n{{display_title}}\n{{content}}');
        expect(single.filepath).toContain(`${expected}.md`);
        const text = String(vault.content(single.filepath!));
        expect(text).toContain(`title: "${expected}"`);
        expect(text).toContain(`# ${expected}\n智能标题\n网站标题`);
        service.updateSettings({ ...settings, mergeMode: 'daily' });
        const dailyVault = new FakeVault();
        const daily = await service.renderToVault(dailyVault as never, task, 'Clippings', '{{note_title}}\n{{content}}');
        const merged = String(dailyVault.content(daily.filepath!));
        expect(merged).toContain(`## ${expected}`);
        expect(merged).toContain(`    title: "${expected}"`);
        expect(daily.filepath).not.toContain(expected);
    });
    it('renames an owned note on the next sync but preserves a conflicting manual file', async () => {
        const settings = makeSettings({ titleMode: 'website', filenameTemplate: '{{note_title}}', frontmatterTemplate: NEW_DEFAULT_FRONTMATTER_TEMPLATE, imageMode: 'disabled' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const first = await service.renderToVault(vault as never, makeTask({ display_title: '旧标题' }), 'Clippings', '{{note_title}}');
        const next = await service.renderToVault(vault as never, makeTask({ display_title: '新标题' }), 'Clippings', '{{note_title}}');
        expect(first.filepath).toBe('Clippings/旧标题.md');
        expect(next.filepath).toBe('Clippings/新标题.md');
        expect(vault.content(first.filepath!)).toBeUndefined();
        await vault.create('Clippings/手写标题.md', '手写正文');
        const conflict = await service.renderToVault(vault as never, makeTask({ display_title: '手写标题' }), 'Clippings', '{{note_title}}');
        expect(conflict.skipped).toBe(true);
        expect(vault.content('Clippings/手写标题.md')).toBe('手写正文');
        expect(vault.content(next.filepath!)).toContain('title: "新标题"');
    });


    it.each([NEW_DEFAULT_FRONTMATTER_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE, ''])('always renders the required default metadata fields (%s)', template => {
        const service = new SyncService(makeSettings({ frontmatterTemplate: template }));
        const emptyTask = makeTask({ source_date: null, tags: [], url: '' });
        const empty = parse(service['generateFrontmatter'](emptyTask, emptyTask.title!).split('---')[1]);
        expect(empty).toMatchObject({ title: emptyTask.title, date: '', tags: [], url: '' });
        const task = makeTask({ source_date: '2026-10-08', tags: [{ id: 1, name: '标签 "A"\\B' }], url: 'https://example.com/?q="A"' });
        const filled = parse(service['generateFrontmatter'](task, task.title!).split('---')[1]);
        expect(filled).toMatchObject({ title: task.title, date: '2026-10-08', tags: ['标签 "A"\\B'], url: task.url });
    });

    it('uses the website title and escaped URL in the new default template', async () => {
        const service = new SyncService(makeSettings({
            filenameTemplate: NEW_DEFAULT_FILENAME_TEMPLATE,
            frontmatterTemplate: NEW_DEFAULT_FRONTMATTER_TEMPLATE,
            imageMode: 'disabled',
        }));
        const vault = new FakeVault();
        const task = makeTask({ title: 'AI 标题', source_title: '原始标题', display_title: 'AI 标题', url: 'https://example.com/?q="quoted"' });
        const result = await service.renderToVault(vault as never, task, 'Clippings', '{{content}}');
        expect(result.filepath).toContain('AI 标题.md');
        const content = String(vault.content(result.filepath!));
        expect(content).toContain('title: "AI 标题"');
        expect(content).toContain('url: "https://example.com/?q=\\"quoted\\""');

        const noSource = makeTask({ id: 102, title: 'AI 标题', source_title: null, display_title: 'AI 标题' });
        const fallback = await service.renderToVault(new FakeVault() as never, noSource, 'Clippings', '{{content}}');
        expect(fallback.filepath).toContain('AI 标题.md');
    });

    it('keeps template variable meanings separate from the account display choice', () => {
        const service = new SyncService(makeSettings());
        const task = makeTask({ title: 'AI 标题', source_title: '原始标题', display_title: 'AI 标题' });
        const render = service['renderBodyTemplate'].bind(service);
        expect(render('{{title}}|{{source_title}}|{{source_title_or_title}}|{{display_title}}', task))
            .toContain('AI 标题|原始标题|原始标题|AI 标题');
    });

    it('previews source-title variables separately from the task title', () => {
        const service = new SyncService(makeSettings({
            targetFolder: 'Clippings/{{source_title}}',
            filenameTemplate: '{{source_title}}-{{title}}',
        }));

        expect(service.renderTemplatePreview('{{source_title}} | {{title}}'))
            .toContain('<!-- biji-task-id:9527 -->\n\n示例原文 | Clip2MD 使用示例');
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
        const expectedContent = '---\ntitle: "Test Title"\ndate: "2026-08-07T10:00:00Z"\nsource: "微信公众号"\ntags: []\nurl: "https://example.com/post"\ntask_id: 101\n---\n\n<!-- biji-task-id:101 -->\n\n## Note\n\nhello\n\n# 原文\n\n# Source\n\nworld';

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

    it('summarizes daily tasks once and updates tags, links, and task order', async () => {
        const service = new SyncService(makeSettings({ mergeMode: 'daily', imageMode: 'disabled' }));
        const vault = new FakeVault();
        const first = makeTask({ id: 101, title: '第一篇', tags: [{ id: 1, name: '知识', source: 'USER', upstream_type: 'manual' }] });
        const second = makeTask({ id: 102, title: '第二篇', url: 'https://example.com/two', tags: [{ id: 2, name: '工作', source: 'USER', upstream_type: 'manual' }] });
        const firstResult = await service.renderToVault(vault as never, first, 'Clippings', '{{content}}');
        const filepath = firstResult.filepath!;
        const firstContent = String(vault.content(filepath));
        expect(firstContent).toMatch(/^---\n/);
        expect(firstContent).toContain('task_count: 1');
        expect(firstContent).toContain('task_ids: [101]');
        expect(firstContent).toContain('<!-- clip2md-daily-frontmatter:v1 -->');

        await service.renderToVault(vault as never, second, 'Clippings', '{{content}}');
        let content = String(vault.content(filepath));
        expect(content.match(/^---$/gm)).toHaveLength(2);
        expect(content).toContain('tags: ["知识","工作"]');
        expect(content).toContain('task_count: 2');
        expect(content).toContain('task_ids: [101,102]');
        expect(content).toContain('title: "第一篇"');
        expect(content).toContain('title: "第二篇"');
        expect(content).toContain('url: "https://example.com/two"');

        await vault.modify(vault.getFileByPath(filepath)!, `${content}\n用户手写内容\n`);
        await service.renderToVault(vault as never, first, 'Clippings', '{{content}}');
        content = String(vault.content(filepath));
        expect(content).toContain('用户手写内容');
        expect(content).toContain('task_ids: [101,102]');
        expect(content.match(/clip2md-daily-frontmatter:v1/g)).toHaveLength(1);
        expect(content.match(/clip2md-task-start:101/g)).toHaveLength(1);
    });

    it('shows the same merged frontmatter and body in preview as a new daily file', async () => {
        const settings = makeSettings({ mergeMode: 'daily', imageMode: 'disabled' });
        const service = new SyncService(settings);
        const vault = new FakeVault();
        const result = await service.renderToVault(vault as never,
            service.createPreviewTask(), 'Clippings', settings.template);
        expect(vault.content(result.filepath!)).toBe(service.renderTemplatePreview(settings.template));
    });

    it('updates a custom daily frontmatter template with a trailing newline', async () => {
        const service = new SyncService(makeSettings({
            mergeMode: 'daily', imageMode: 'disabled',
            dailyMergeFrontmatterTemplate: '---\ntask_count: {{task_count}}\ntask_ids: {{task_ids}}\n---\n',
        }));
        const vault = new FakeVault();
        const first = await service.renderToVault(vault as never, makeTask(), 'Clippings', '{{content}}');
        await service.renderToVault(vault as never, makeTask({ id: 102 }), 'Clippings', '{{content}}');
        const content = String(vault.content(first.filepath!));
        expect(content).toContain('task_count: 2');
        expect(content.match(/clip2md-daily-frontmatter:v1/g)).toHaveLength(1);
    });

    it('silently builds metadata for a legacy daily file and preserves old blocks', async () => {
        const service = new SyncService(makeSettings({ mergeMode: 'daily', imageMode: 'disabled' }));
        const vault = new FakeVault();
        const filepath = 'Clippings/2026-08-08-微信公众号.md';
        const oldBlock = '<!-- clip2md-task-start:77 -->\n## 旧文章\n\n旧正文\n<!-- clip2md-task-end:77 -->';
        await vault.create(filepath, `# 微信公众号 · 2026-08-08\n\n${oldBlock}\n\n手写结尾`);
        const result = await service.renderToVault(vault as never, makeTask(), 'Clippings', '{{content}}');
        const content = String(vault.content(filepath));
        expect(result.warning).toBeUndefined();
        expect(content).toContain('task_count: 2');
        expect(content).toContain('task_ids: [77,101]');
        expect(content).toContain('title: "旧文章"');
        expect(content).not.toContain('url: ""');
        expect(content).toContain(oldBlock);
        expect(content).toContain('手写结尾');
    });

    it('preserves an existing handwritten daily frontmatter and reports migration once', async () => {
        const service = new SyncService(makeSettings({ mergeMode: 'daily', imageMode: 'disabled' }));
        const vault = new FakeVault();
        const filepath = 'Clippings/2026-08-08-微信公众号.md';
        await vault.create(filepath, '---\ncustom: keep\n---\n\n# 日记\n\n手写内容');
        const first = await service.renderToVault(vault as never, makeTask(), 'Clippings', '{{content}}');
        expect(first.warning).toContain('请手动迁移');
        const second = await service.renderToVault(vault as never, makeTask(), 'Clippings', '{{content}}');
        expect(second.warning).toBeUndefined();
        const content = String(vault.content(filepath));
        expect(content).toMatch(/^---\ncustom: keep\n---/);
        expect(content).not.toContain('clip2md-daily-frontmatter:v1');
        expect(content).toContain('手写内容');
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
