import { refreshCommentLinks, type CommentSource } from './comment-source';
import { parseDocument } from 'yaml';
// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { SyncService, type SyncTask } from './sync';
import type { BijiSyncSettings } from './settings';
import { archiveConfig, fetchArchiveSnapshot, isExcluded, newSubscriptionState, type SubscriptionContext } from './subscriptions';
import { documentMetadata, region } from './subscription-document';
import { rebuildSubscriptionArchive, collidingSubscriptions } from './subscription-archive';
import { sha256, verifySavedSyncProof } from './saved-sync-proof';
import BijiSyncPlugin from './main';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const request = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<typeof import('obsidian')>(), requestUrl: request }));
const context: SubscriptionContext = { kind: 'work', account_id: 'account-a', subscription_id: 2, platform: 'youtube',
    blogger_id: 'UC-test', nickname: '昵称', remark: '产品设计', work_id: 'abcdefghijk',
    first_discovered_at: '2026-10-14T01:00:00Z', published_kind: 'relative', published_text: '昨天' };
function settings(overrides: Partial<BijiSyncSettings> = {}): BijiSyncSettings {
    return { apiKey: 'test', installationId: 'test', settingsSchemaVersion: 3, syncInterval: 0, syncOnStart: false,
        preventReimportAfterLocalRemoval: false, targetFolder: 'Clip2MD', filenameTemplate: '{{title}}', filenameDateFormat: 'yyyy-MM-dd',
        template: '{{content}}', frontmatterTemplate: '---\ntitle: "{{title}}"\ntags: [用户标签]\n---', dailyMergeFrontmatterTemplate: '',
        syncContentMode: 'full', imageMode: 'local', imageFolder: '', mergeMode: 'daily',
        subscriptionAccounts: { 'account-a': { ...archiveConfig(), enabled: true } }, ...overrides };
}
function task(id = 12, c = context): SyncTask {
    return { id, subscription_context: c, url: 'https://youtube.com/watch?v=abcdefghijk', status: 'SUCCESS', title: '作品',
        summary: null, note_markdown_content: '## 内容\n\n云端正文', source_markdown_content: null,
        note_content_version: 1, source_content_version: 1, source_date: null, duration_seconds: null, content_type: 'LINK', content_source: 'wechat',
        asset_count: 0, asset_ready_count: 0, asset_pending_count: 0, asset_failed_count: 0, assets_updated_at: null,
        created_at: '2026-10-14T01:00:00Z', updated_at: '2026-10-14T01:00:00Z', source_title: null, source_description: null,
        ack_token: 'token', ack_scope: { version: 2, content_mode: 'full', required_assets: [] } };
}
class TestVault {
    files = new Map<string, string | ArrayBuffer>(); folders = new Set<string>(); beforeProcess?: (path: string) => void;
    file(path: string) { return Object.assign(new TFile(), { path, basename: path.split('/').pop()!.replace(/\.md$/, ''), parent: { path: path.split('/').slice(0, -1).join('/') } }); }
    getFileByPath(path: string) { return this.files.has(path) ? this.file(path) : null; }
    getAbstractFileByPath(path: string) { return this.folders.has(path) ? Object.assign(new TFolder(), { path }) : this.getFileByPath(path); }
    getMarkdownFiles() { return [...this.files.keys()].filter(p => p.endsWith('.md')).map(p => this.file(p)); }
    async createFolder(path: string) { this.folders.add(path); }
    async create(path: string, text: string) { if (this.files.has(path)) throw new Error('file exists'); this.files.set(path, text); return this.file(path); }
    async createBinary(path: string, bytes: ArrayBuffer) { this.files.set(path, bytes); }
    async modifyBinary(file: TFile, bytes: ArrayBuffer) { this.files.set(file.path, bytes); }
    async readBinary(file: TFile) { return this.files.get(file.path) as ArrayBuffer; }
    async read(file: TFile) { if (!this.files.has(file.path)) throw new Error('missing file'); return String(this.files.get(file.path)); }
    async cachedRead(file: TFile) { return this.read(file); }
    async process(file: TFile, change: (content: string) => string) {
        this.beforeProcess?.(file.path); this.beforeProcess = undefined;
        const next = change(await this.read(file)); this.files.set(file.path, next); return next;
    }
    async modify(file: TFile, text: string) { this.files.set(file.path, text); }
    app() { return { vault: this, fileManager: { generateMarkdownLink: (file: TFile, _path: string, _subpath?: string, alias?: string) => `[[${file.path}|${alias || file.basename}]]` } }; }
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); request.mockReset(); });

describe('subscription archive integration', () => {
    it('creates per-blogger notes and keeps path, user properties and annotations across cloud updates', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), t = task();
        const first = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(first.filepath).toBe('Clip2MD/博主订阅/youtube/产品设计/作品.md');
        const path = first.filepath!, original = String(vault.files.get(path));
        expect(documentMetadata(original)?.published_text).toBe('昨天');
        expect(documentMetadata(original)?.published_at).toBeUndefined();
        vault.files.set(path, original.replace('tags: [ 用户标签 ]', 'tags: [ 自定义 ]') + '\n我的想法与 ![用户图片](local.png)');
        config.subscriptionAccounts!['account-a'].folderTemplate = '其他目录/{{blogger_name}}';
        sync.updateSettings(config);
        const next = await sync.renderToVault(vault as never, { ...t, title: '改名', note_markdown_content: '新正文' }, config.targetFolder, config.template);
        expect(next.filepath).toBe(path); expect(next.skipped).toBe(false);
        expect(String(vault.files.get(path))).toContain('我的想法'); expect(String(vault.files.get(path))).toContain('新正文');
        expect(await verifySavedSyncProof(vault as never, t.id, next.savedProof!)).toBe(true);
        vault.files.set(path, String(vault.files.get(path)) + '\n再次批注');
        expect(await verifySavedSyncProof(vault as never, t.id, next.savedProof!)).toBe(true);
        vault.files.set(path, String(vault.files.get(path)).replace('新正文', '用户改写正文'));
        expect(await verifySavedSyncProof(vault as never, t.id, next.savedProof!)).toBe(false);
        const blocked = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(blocked.subscriptionConflict).toBe(true); expect(blocked.savedProof).toBeUndefined();
        expect(String(vault.files.get(path))).toContain('用户改写正文');
    });

    it('holds uncertain legacy notes and preserves them with a backup after explicit upgrade', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), t = task();
        const old = '---\ncustom: keep\n---\n<!-- biji-task-id:12 -->\n旧正文\n我的批注';
        await vault.create('旧目录/旧名.md', old); sync.loadTaskFileMap({ 12: '旧目录/旧名.md' });
        const blocked = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(blocked.subscriptionConflict).toBe(true); expect(vault.files.get('旧目录/旧名.md')).toBe(old);
        sync.authorizeSubscriptionReplacement(12, old);
        const result = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(result.filepath).toBe('旧目录/旧名.md');
        expect(String(vault.files.get(result.filepath!))).toContain('旧正文\n我的批注');
        expect(String(vault.files.get(result.filepath!))).toContain('custom: keep');
        expect([...vault.files.keys()].filter(p => p.startsWith('.clip2md-subscription-backups/'))).toHaveLength(1);
    });

    it('automatically upgrades a legacy note only with a matching durable baseline', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), t = task();
        const old = '<!-- biji-task-id:12 -->\n未修改的旧笔记'; await vault.create('旧.md', old);
        sync.loadTaskFileMap({ 12: '旧.md' }); sync.configureArchive([], { 12: { filepath: '旧.md', contentHash: await sha256(old) } });
        const result = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(result.skipped).toBe(false); expect(region(String(vault.files.get('旧.md')), 'cloud', 12)).not.toBeNull();
    });

    it('rechecks managed content in the atomic write and retains concurrent edits', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), t = task();
        const first = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        vault.beforeProcess = path => { vault.files.set(path, String(vault.files.get(path)).replace('云端正文', '并发编辑')); };
        const result = await sync.renderToVault(vault as never, { ...t, note_markdown_content: '新版本' }, config.targetFolder, config.template);
        expect(result.subscriptionConflict).toBe(true); expect(String(vault.files.get(first.filepath!))).toContain('并发编辑');
    });

    it('builds bidirectional links, report links and indexes from surviving local files', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config);
        const comment = task(13, { ...context, kind: 'comment_supplement', original_task_id: 12, original_url: 'https://youtube.com/watch?v=abcdefghijk' });
        comment.title = '评论补充';
        await sync.renderToVault(vault as never, comment, config.targetFolder, config.template);
        await sync.renderToVault(vault as never, task(), config.targetFolder, config.template);
        const report = task(14, { kind: 'daily_report', account_id: 'account-a', report_date: '2026-10-13', related_works: [{ task_id: 12 }] });
        const saved = await sync.renderToVault(vault as never, report, config.targetFolder, config.template);
        expect(saved.filepath).toBe('Clip2MD/博主订阅/日报/2026-10-13-博主订阅日报.md');
        const state = newSubscriptionState(), map = sync.getTaskFileMap();
        let archive = await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, map);
        expect(archive.errors).toEqual([]);
        expect(String(vault.files.get(map[12]))).toContain('评论补充.md');
        expect(String(vault.files.get(map[13]))).toContain('作品.md');
        expect(String(vault.files.get(map[14]))).toContain('作品.md');
        if (process.env.CLIP2MD_TEST_VAULT_DIR) {
            for (const [name, content] of vault.files) {
                const output = path.join(process.env.CLIP2MD_TEST_VAULT_DIR, name);
                await mkdir(path.dirname(output), { recursive: true });
                await writeFile(output, typeof content === 'string' ? content : new Uint8Array(content));
            }
        }
        const index = [...vault.files.keys()].find(p => p.endsWith('_博主索引.md'))!;
        expect(String(vault.files.get(index))).toContain('发现时间');
        vault.files.set(index, String(vault.files.get(index)) + '\n我的索引批注');
        const content = vault.files.get(map[12])!; vault.files.delete(map[12]); vault.files.set('手动移动.md', content);
        archive = await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, map);
        expect(map[12]).toBe('手动移动.md'); expect(String(vault.files.get(index))).toContain('手动移动.md');
        expect(String(vault.files.get(index))).toContain('我的索引批注');
        vault.files.delete('手动移动.md');
        await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, map);
        expect(String(vault.files.get(map[14]))).not.toContain('[[手动移动.md');
    });

    it('isolates accounts and detects duplicate local identities without replacing unrelated files', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config);
        const result = await sync.renderToVault(vault as never, task(), config.targetFolder, config.template);
        await vault.create('复制.md', String(vault.files.get(result.filepath!)));
        const state = newSubscriptionState();
        const archive = await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, sync.getTaskFileMap());
        expect(archive.errors.length).toBeGreaterThan(0); expect(state.statuses[12].status).toBe('conflict');
        const other = await rebuildSubscriptionArchive(vault.app() as never, 'account-b', archiveConfig(), state, {});
        expect(other.notes).toEqual([]);
    });

    it('handles sanitized directory collisions, per-blogger overrides and independent report scope', () => {
        const a = { ...context, remark: '同/名' }, b = { ...context, subscription_id: 3, remark: '同_名' };
        const config = archiveConfig({ enabled: true });
        expect(collidingSubscriptions([a, b], config)).toEqual([2, 3]);
        config.bloggers['2'] = { folder: '手选目录', enabled: false };
        expect(collidingSubscriptions([a, b], config)).toEqual([]);
        expect(isExcluded(a, config)).toBe(true);
        expect(isExcluded({ ...a, kind: 'comment_supplement' }, config)).toBe(true);
        expect(isExcluded({ kind: 'daily_report', account_id: 'account-a', report_date: '2026-10-14' }, config)).toBe(false);
    });

    it('clears deleted works from an existing index and preserves user index annotations', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), state = newSubscriptionState();
        const result = await sync.renderToVault(vault as never, task(), config.targetFolder, config.template);
        await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, sync.getTaskFileMap());
        const index = [...vault.files.keys()].find(p => p.endsWith('_博主索引.md'))!;
        vault.files.set(index, String(vault.files.get(index)) + '\n个人整理'); vault.files.delete(result.filepath!);
        const rebuilt = await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, sync.getTaskFileMap());
        expect(rebuilt.errors).toEqual([]); expect(String(vault.files.get(index))).not.toContain('作品.md');
        expect(String(vault.files.get(index))).toContain('个人整理');
    });

    it('requires review and backup to replace edited index content', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), state = newSubscriptionState();
        await sync.renderToVault(vault as never, task(), config.targetFolder, config.template);
        await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, sync.getTaskFileMap());
        const index = [...vault.files.keys()].find(p => p.endsWith('_博主索引.md'))!;
        const edited = String(vault.files.get(index)).replace('## 已同步作品', '## 用户改写自动区') + '\n我的整理'; vault.files.set(index, edited);
        const blocked = await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state, sync.getTaskFileMap());
        expect(blocked.indexConflicts).toHaveLength(1); expect(vault.files.get(index)).toBe(edited);
        const repaired = await rebuildSubscriptionArchive(vault.app() as never, 'account-a', config.subscriptionAccounts!['account-a'], state,
            sync.getTaskFileMap(), new Map([[2, edited]]));
        expect(repaired.errors).toEqual([]); expect(String(vault.files.get(index))).toContain('我的整理');
        expect(String(vault.files.get(index))).toContain('## 已同步作品');
        expect([...vault.files.keys()].some(p => p.startsWith('.clip2md-subscription-backups/'))).toBe(true);
    });

    it('verifies local images separately from user annotation images', async () => {
        const vault = new TestVault(), config = settings(), sync = new SyncService(config), t = task();
        t.note_markdown_content = '![来源图片](/api/v1/assets/8)';
        t.ack_scope!.required_assets = [{ id: 8, url: '/api/v1/assets/8', status: 'READY' }];
        // Node WebCrypto requires a Node-realm buffer in the JSDOM test environment.
        const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
        const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
        request.mockResolvedValue({ status: 200, arrayBuffer: bytes, headers: { 'content-type': 'image/png' } });
        const result = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(result.imageErrors).toEqual([]); expect(result.verifiedAssetIds).toEqual([8]); expect(result.savedProof?.images).toHaveLength(1);
        vault.files.set(result.filepath!, String(vault.files.get(result.filepath!)) + '\n![我的图片](missing.png)');
        expect(await verifySavedSyncProof(vault as never, t.id, result.savedProof!)).toBe(true);
        vault.files.delete(result.savedProof!.images[0].path);
        expect(await verifySavedSyncProof(vault as never, t.id, result.savedProof!)).toBe(false);
        request.mockResolvedValue({ status: 503 });
        const failed = await sync.renderToVault(vault as never, t, config.targetFolder, config.template);
        expect(failed.pendingAssets).toBe(true); expect(failed.selectedContentWritten).toBe(false);
    });

    it('persists excluded tasks without queuing a receipt and processes them when enabled again', async () => {
        const config = settings(); config.subscriptionAccounts!['account-a'].bloggers['2'] = { enabled: false };
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
        const state = newSubscriptionState(); state.accountId = 'account-a';
        const render = vi.fn(async () => ({ filepath: 'saved.md', skipped: false }));
        Object.assign(plugin, { settings: config, localState: { subscriptions: state }, subscriptionNotes: [],
            syncService: { removePending: vi.fn(), renderToVault: render, markComplete: vi.fn() },
            syncAckQueue: { remove: vi.fn(async () => {}), enqueue: vi.fn(), flush: vi.fn() }, app: { vault: {} },
            persistSyncState: vi.fn(async () => {}), updateSyncProgress: vi.fn(), recordBlockedAck: vi.fn() });
        const counters = { processed: 0, skipped: 0, succeeded: 0, pending: 0, ignored: 0, ackBlockedCount: 0, ackBlockedReasons: new Set() };
        await plugin['processTasks']([task()], counters as never);
        expect(state.excludedTaskIds).toEqual([12]); expect(render).not.toHaveBeenCalled();
        expect(plugin['syncAckQueue'].enqueue).not.toHaveBeenCalled();
        config.subscriptionAccounts!['account-a'].bloggers['2'].enabled = true;
        const t = task(); t.ack_scope = null; t.ack_token = null;
        await plugin['processTasks']([t], counters as never);
        expect(render).toHaveBeenCalledOnce(); expect(state.excludedTaskIds).toEqual([]);
        expect(state.statuses[12].status).toBe('synced');
    });

    it('records a scope change while a receipt is queued so re-enabling can recover the task', async () => {
        const config = settings(), sync = new SyncService(config), vault = new TestVault();
        const result = await sync.renderToVault(vault as never, task(), config.targetFolder, config.template);
        config.subscriptionAccounts!['account-a'].bloggers['2'] = { enabled: false };
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin, state = newSubscriptionState();
        state.accountId = 'account-a';
        Object.assign(plugin, { settings: config, localState: { subscriptions: state }, syncService: sync,
            app: vault.app(), syncWriteInProgress: false, persistSyncState: vi.fn(async () => {}) });
        const disposition = await plugin['deliverSyncAck']({ taskId: 12, ackToken: 'token', imagesProcessed: 0,
            imagesFailed: 0, scopeVersion: 2, contentMode: 'full', savedProof: result.savedProof });
        expect(disposition).toBe('discard'); expect(state.excludedTaskIds).toEqual([12]);
        expect(state.statuses[12].status).toBe('excluded'); expect(request).not.toHaveBeenCalled();
    });
});

describe('read-only subscription client', () => {
    it('resets account-specific runtime state without removing local notes after a confirmed account change', async () => {
        const vault = new TestVault(); await vault.create('用户笔记.md', '保持原文件');
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
        const config = settings(), sync = new SyncService(config), state = newSubscriptionState();
        state.accountId = 'account-a'; state.excludedTaskIds = [12]; sync.setCursor('old-cursor'); sync.loadTaskFileMap({ 12: '用户笔记.md' });
        const queue = { load: vi.fn(), remove: vi.fn() };
        Object.assign(plugin, { settings: config, syncService: sync, localState: { subscriptions: state }, subscriptionNotes: [],
            syncAckQueue: queue, app: { ...vault.app(), workspace: { getLeavesOfType: () => [] } }, persistSyncState: vi.fn(async () => {}) });
        request.mockImplementation(async ({ url }) => url.includes('/works') || url.includes('/reports')
            ? { status: 200, json: { items: [], total: 0 } }
            : { status: 200, json: { account_id: 'account-b', features: {}, items: [] } });
        await plugin.refreshSubscriptionSnapshot();
        expect(plugin.getSubscriptionState().accountId).toBe('account-b');
        expect(plugin.getSubscriptionState().excludedTaskIds).toEqual([]);
        expect(sync.getCursor()).toBeNull(); expect(sync.getTaskFileMap()).toEqual({});
        expect(queue.load).toHaveBeenCalledWith([]); expect(vault.files.get('用户笔记.md')).toBe('保持原文件');
        expect(plugin.getSubscriptionConfig().enabled).toBe(false);
    });

    it('cannot enqueue deletion receipts if subscription state persistence fails after writing', async () => {
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin, state = newSubscriptionState();
        state.accountId = 'account-a';
        const enqueue = vi.fn();
        Object.assign(plugin, { settings: settings(), localState: { subscriptions: state }, subscriptionNotes: [],
            syncService: { renderToVault: vi.fn(async () => ({ filepath: 'saved.md', skipped: false })), getIgnoredTaskIds: () => [] },
            syncAckQueue: { enqueue, flush: vi.fn() }, app: { vault: {} },
            persistSyncState: vi.fn(async () => { throw new Error('本机状态无法持久化'); }) });
        const counters = { processed: 0, skipped: 0, succeeded: 0, pending: 0, ignored: 0, ackBlockedCount: 0, ackBlockedReasons: new Set() };
        await expect(plugin['processTasks']([task()], counters as never)).rejects.toThrow('无法持久化');
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('paginates with the device key and rejects unsupported servers', async () => {
        request.mockResolvedValueOnce({ status: 404 });
        await expect(fetchArchiveSnapshot('key')).rejects.toThrow('暂不支持');
        request.mockImplementation(async ({ url }) => url.includes('/works') ? { status: 200, json: { items: [{ id: 1, subscription_id: 2, work_id: 'new', platform: 'youtube', url: 'https://youtube.com/watch?v=new', metadata: {}, baseline: false, first_discovered_at: '2026-10-17', task_id: null, clip_status: null, clip_outcome: null, comment_status: null, supplement_task_id: null }], total: 1 } }
            : url.includes('/reports') ? { status: 200, json: { items: [], total: 0 } }
            : { status: 200, json: { account_id: 'a', features: {}, items: [] } });
        const snapshot = await fetchArchiveSnapshot('device-key');
        expect(snapshot.works).toHaveLength(1); expect(snapshot.fetchedAt).toBeTruthy();
        expect(request.mock.calls.at(-1)![0].headers['X-API-Key']).toBe('device-key');
    });
});


const commentSource: CommentSource = { platform: 'youtube', title: '原帖 [标题]: "示例"', author: '作者',
    url: 'https://youtube.com/watch?v=abcdefghijk', work_id: 'abcdefghijk', collected_at: '2026-10-15T10:59:00Z',
    main_task_id: 12, main_task_title: '作品', work_record_id: 2, header_markdown: '# 评论 · 作品\n\n- **原作品**：作品\n' };

it.each([true, false])('stores comment properties and a local backlink with safe receipts (subscription=%s)', async subscription => {
    const vault = new TestVault(), config = settings({ mergeMode: 'none' }), sync = new SyncService(config);
    const original = task();
    const main = await sync.renderToVault(vault as never, original, config.targetFolder, config.template);
    const comment = { ...task(13, { ...context, kind: 'comment_supplement', original_task_id: 12 }),
        subscription_context: subscription ? { ...context, kind: 'comment_supplement' as const, original_task_id: 12 } : undefined,
        title: '评论', content_source: 'comment_supplement', note_markdown_content: null,
        source_markdown_content: commentSource.header_markdown + '\n## 最新互动数据\n\n## 评论原文\n\n> 样本', comment_source: commentSource };
    const result = await sync.renderToVault(vault as never, comment, config.targetFolder, config.template);
    const content = String(vault.files.get(result.filepath!));
    const yaml = parseDocument(/^---\n([\s\S]*?)\n---/.exec(content)![1]).toJS();
    expect(yaml['原帖标题']).toBe(commentSource.title);
    expect(yaml['主笔记']).toBe(`[[${main.filepath!.replace(/\.md$/, '')}]]`);
    expect(content).not.toContain('- **原作品**');
    expect(content).toContain('> 样本');
    expect(result.selectedContentWritten).toBe(true);
    expect(await verifySavedSyncProof(vault as never, 13, result.savedProof!)).toBe(true);
    vault.files.set(result.filepath!, content.replace('原帖作者: 作者', '原帖作者: 改写'));
    expect(await verifySavedSyncProof(vault as never, 13, result.savedProof!)).toBe(false);
});

it('adds the backlink when the main note arrives later and preserves manual properties', async () => {
    const vault = new TestVault(), config = settings({ mergeMode: 'none' }), sync = new SyncService(config);
    const comment = { ...task(13), subscription_context: undefined, title: '评论', content_source: 'comment_supplement',
        note_markdown_content: null, source_markdown_content: '用户前言\n' + commentSource.header_markdown + '\n## 评论原文\n> 原文', comment_source: commentSource };
    const result = await sync.renderToVault(vault as never, comment, config.targetFolder, config.template);
    const before = String(vault.files.get(result.filepath!));
    expect(before).toContain('用户前言');
    expect(before).toContain('- **原作品**');
    expect(before).toContain('主笔记: null');
    await sync.renderToVault(vault as never, task(), config.targetFolder, config.template);
    await refreshCommentLinks(vault as never, sync.getTaskFileMap());
    expect(String(vault.files.get(result.filepath!))).toContain('主笔记: "[[Clip2MD/博主订阅/youtube/产品设计/作品]]"');
    expect(String(vault.files.get(result.filepath!))).toContain('用户标签');
    const userEdited = String(vault.files.get(result.filepath!)).replace('[[Clip2MD/博主订阅/youtube/产品设计/作品]]', '[[我的关联]]');
    vault.files.set(result.filepath!, userEdited);
    await refreshCommentLinks(vault as never, sync.getTaskFileMap());
    expect(vault.files.get(result.filepath!)).toBe(userEdited);
});
