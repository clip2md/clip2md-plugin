import { ItemView, Modal, Notice, Setting, type WorkspaceLeaf, type TAbstractFile } from 'obsidian';
import type BijiSyncPlugin from './main';
import { action } from './subscription-settings';
import { FolderPickerModal } from './settings';
import type { IndexConflict } from './subscription-archive';
import { isArchiveRecord, positiveId } from './subscriptions';

export const SUBSCRIPTION_VIEW_TYPE = 'clip2md-blogger-subscriptions';
const localStatuses: Record<string, string> = { pending: '待同步', synced: '已同步', excluded: '已排除', conflict: '批注冲突', images: '图片失败 / 待处理', error: '本地同步失败' };
const cloudStatus = (value: string | null) => value === 'SUCCESS' ? '云端已完成'
    : ['PENDING', 'PROCESSING', 'WAITING_SERVICE'].includes(value || '') ? '云端处理中'
    : value?.startsWith('FAILED') ? '云端失败' : value === null ? '云端未剪藏' : '未知状态';


class SubscriptionConflictModal extends Modal {
    constructor(private plugin: BijiSyncPlugin, private id: number) { super(plugin.app); }
    async onOpen() {
        this.titleEl.setText('订阅笔记更新冲突');
        const path = this.plugin.syncService.getTaskFileMap()[this.id];
        const file = path ? this.app.vault.getFileByPath(path) : null;
        if (!file) { this.contentEl.createEl('p', { text: '本地笔记不存在，未进行覆盖。' }); return; }
        const current = await this.app.vault.read(file);
        this.contentEl.createEl('p', { text: '比较本地文件与云端所选内容。确认后先备份原文件；旧笔记升级会保留原正文。' });
        this.contentEl.createEl('h3', { text: '本地文件' });
        this.contentEl.createEl('pre', { text: current, cls: 'clip2md-subscription-diff' });
        action(this.contentEl, '保留本地修改', async () => { await this.plugin.keepLocalSubscription(this.id); this.close(); });
        try {
            const result = (await this.plugin.syncService.fetchTasksByIds([this.id]))[0];
            if (!result?.task) throw new Error('云端资料不可用，原文件保持不变');
            this.contentEl.createEl('h3', { text: '云端内容（按当前正文模板预览，图片在同步时本地化）' });
            this.contentEl.createEl('pre', { text: this.plugin.syncService.previewTask(result.task), cls: 'clip2md-subscription-diff' });
            action(this.contentEl, '确认备份并使用云端版本', async () => {
                await this.plugin.replaceSubscription(this.id, current); this.close();
            });
        } catch (error) { this.contentEl.createEl('p', { text: String(error), attr: { role: 'status' } }); }
    }
    onClose() { this.contentEl.empty(); }
}

class IndexConflictModal extends Modal {
    constructor(private plugin: BijiSyncPlugin, private conflict: IndexConflict) { super(plugin.app); }
    onOpen() {
        this.titleEl.setText('博主索引更新冲突');
        this.contentEl.createEl('p', { text: this.conflict.path });
        this.contentEl.createEl('h3', { text: '当前索引' });
        this.contentEl.createEl('pre', { text: this.conflict.current, cls: 'clip2md-subscription-diff' });
        this.contentEl.createEl('h3', { text: '自动区域的新内容' });
        this.contentEl.createEl('pre', { text: this.conflict.proposed, cls: 'clip2md-subscription-diff' });
        action(this.contentEl, '保留本地修改', async () => { await this.plugin.resolveSubscriptionIndex(this.conflict, false); this.close(); });
        action(this.contentEl, '确认备份并重建自动区域', async () => { await this.plugin.resolveSubscriptionIndex(this.conflict, true); this.close(); });
    }
    onClose() { this.contentEl.empty(); }
}

export class SubscriptionView extends ItemView {
    private blogger = ''; private platform = ''; private kind = ''; private status = '';
    private account?: string;
    constructor(leaf: WorkspaceLeaf, private plugin: BijiSyncPlugin) { super(leaf); }
    getViewType() { return SUBSCRIPTION_VIEW_TYPE; }
    getDisplayText() { return '博主订阅'; }
    getIcon() { return 'rss'; }
    async onOpen() {
        this.render(); await this.plugin.refreshSubscriptionSnapshot(); await this.plugin.rebuildSubscriptions(); this.render();
    }
    render() {
        const focused = this.contentEl.contains(document.activeElement) ? document.activeElement?.getAttribute('data-control') : null;
        const state = this.plugin.getSubscriptionState(), snapshot = state.unverified ? undefined : state.snapshot;
        if (state.unverified || this.account !== state.accountId) {
            if (this.account) this.blogger = this.platform = this.kind = this.status = '';
        }
        const root = this.contentEl; root.empty(); root.addClass('clip2md-subscription-view');
        root.createEl('h2', { text: '博主订阅' });
        const tools = root.createDiv({ cls: 'clip2md-subscription-actions' });
        action(tools, '刷新', async () => { await this.plugin.refreshSubscriptionSnapshot(); await this.plugin.rebuildSubscriptions(); this.render(); });
        action(tools, '打开插件设置', () => this.plugin.openSettingsTab());
        action(tools, '立即同步', () => this.plugin.syncNow());
        action(tools, '网页管理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
        if (this.plugin.subscriptionError) root.createEl('p', { text: this.plugin.subscriptionError, attr: { role: 'status' } });
        root.createEl('p', { text: snapshot ? `列表获取时间：${snapshot.fetchedAt}` : '暂无已验证的订阅列表，请刷新。', attr: { role: 'status' } });
        for (const error of this.plugin.subscriptionArchiveErrors) root.createEl('p', { text: error, cls: 'clip2md-subscription-error' });
        for (const conflict of this.plugin.subscriptionIndexConflicts || []) action(root,
            `查看索引冲突 #${conflict.id}`, () => { new IndexConflictModal(this.plugin, conflict).open(); });
        const filters = root.createDiv();
        const filter = (label: string, value: string, items: Array<[string, string]>, set: (v: string) => void) => {
            if (value && !items.some(([key]) => key === value)) { value = ''; set(''); }
            new Setting(filters).setName(label).addDropdown(select => {
                select.addOption('', '全部'); for (const [key, name] of items) select.addOption(key, name);
                select.setValue(value).onChange(v => { set(v); this.render(); });
                select.selectEl.setAttribute('data-control', label);
                select.selectEl.setAttribute('aria-label', label);
            });
        };
        filter('博主', this.blogger, (snapshot?.items || []).map(s => [String(s.id), s.name || s.profile?.nickname || s.blogger_id]), v => { this.blogger = v; });
        filter('平台', this.platform, [...new Set((snapshot?.items || []).map(s => s.platform))].map(p => [p, p]), v => { this.platform = v; });
        filter('文档类型', this.kind, [['work', '作品'], ['comment_supplement', '评论补充'], ['daily_report', '日报']], v => { this.kind = v; });
        filter('状态', this.status, [...Object.entries(localStatuses), ['cloud-pending', '云端处理中'], ['cloud-failed', '云端失败'], ['cloud-none', '云端未剪藏'], ['cloud-unknown', '未知状态']], v => { this.status = v; });
        for (const sub of snapshot?.items || []) {
            if (this.blogger && String(sub.id) !== this.blogger || this.platform && sub.platform !== this.platform) continue;
            const info = root.createEl('p');
            info.setText(`${sub.name || sub.profile?.nickname || sub.blogger_id} · 到期 ${sub.ends_at} · 最近扫描 ${sub.last_scan?.status || '暂无'} · 新发现 ${sub.last_scan?.new_work_count ?? 0} 篇`);
        }
        const list = root.createEl('ul', { cls: 'clip2md-subscription-list' });
        const displayed = new Set<number>();
        const row = (id: number | null, kind: string, subId: number | undefined, platform: string | undefined,
            title: string, url: string, cloud: string | null, baseline = false, localOnly = false) => {
            if (id !== null && displayed.has(id)) return;
            const note = this.plugin.getSubscriptionNotes().find(n => n.metadata.task_id === id);
            const ignored = id !== null && this.plugin.syncService.getIgnoredTaskIds().includes(id);
            const local = ignored ? '主动删除' : id !== null ? state.statuses[id]?.status || (note ? 'synced' : 'pending') : '';
            const cloudFilter = localOnly || cloud === 'SUCCESS' ? '' : ['PENDING', 'PROCESSING', 'WAITING_SERVICE'].includes(cloud || '') ? 'cloud-pending' : cloud?.startsWith('FAILED') ? 'cloud-failed' : cloud === null ? 'cloud-none' : 'cloud-unknown';
            if (this.blogger && String(subId) !== this.blogger || this.platform && platform !== this.platform
                || this.kind && kind !== this.kind || this.status && local !== this.status && cloudFilter !== this.status) return;
            if (id !== null) displayed.add(id);
            const li = list.createEl('li'); li.createEl('strong', { text: title });
            li.createEl('p', { text: `${baseline ? '历史基线 · ' : ''}${localOnly ? '本地已保存；云端状态未知或已清理' : cloudStatus(cloud)}${local ? ` · ${localStatuses[local] || local}` : ''}` });
            if (id !== null && state.statuses[id]?.message) li.createEl('p', { text: state.statuses[id].message });
            const actions = li.createDiv({ cls: 'clip2md-subscription-actions' });
            if (note) {
                action(actions, '打开笔记', () => this.app.workspace.getLeaf(false).openFile(note.file));
                action(actions, '打开目录', () => this.openFolder(note.file));
                action(actions, '打开索引', async () => {
                    const index = this.app.vault.getMarkdownFiles().find(f => {
                        const frontmatter: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter;
                        const meta: unknown = isArchiveRecord(frontmatter) ? frontmatter.clip2md_index : undefined;
                        return isArchiveRecord(meta) && meta.account_id === state.accountId && positiveId(meta.subscription_id) && meta.subscription_id === subId;
                    });
                    if (index) await this.app.workspace.getLeaf(false).openFile(index); else new Notice('尚未生成博主索引');
                });
            }
            if (/^https?:\/\//.test(url)) action(actions, '打开原文', () => { window.open(url, '_blank'); });
            if (id !== null && cloud === 'SUCCESS' && !ignored && local !== 'excluded') action(actions, '本地重试', () => this.plugin.retrySubscriptionTask(id));
            if (id !== null && local === 'conflict') action(actions, '查看冲突 / 升级', () => { new SubscriptionConflictModal(this.plugin, id).open(); });
            if (cloudFilter === 'cloud-failed' || cloudFilter === 'cloud-none') action(actions, '网页处理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
        };
        for (const work of snapshot?.works || []) {
            const local = !work.task_id ? this.plugin.getSubscriptionNotes().find(n => n.metadata.kind === 'work'
                && n.metadata.subscription_id === work.subscription_id && n.metadata.work_id === work.work_id) : undefined;
            row(work.task_id || local?.metadata.task_id || null, 'work', work.subscription_id, work.platform,
                work.metadata?.caption || work.work_id, work.url, work.clip_status, work.baseline, !!local);
            if (work.supplement_task_id) row(work.supplement_task_id, 'comment_supplement', work.subscription_id, work.platform,
                `${work.metadata?.caption || work.work_id} · 评论补充`, work.url, work.supplement_status || null);
        }
        for (const report of snapshot?.reports || []) row(report.task_id, 'daily_report', undefined, undefined, `${report.date} 博主订阅日报`, 'https://clip2.md/app/bloggers', report.status);
        const cloudIds = new Set([
            ...(snapshot?.works || []).flatMap(w => [w.task_id, w.supplement_task_id]),
            ...(snapshot?.reports || []).map(r => r.task_id),
        ]);
        for (const n of this.plugin.getSubscriptionNotes()) if (!cloudIds.has(n.metadata.task_id) && !displayed.has(n.metadata.task_id)) {
            row(n.metadata.task_id, n.metadata.kind, n.metadata.subscription_id, n.metadata.platform,
                n.metadata.title || n.file.basename, n.metadata.url || '', 'SUCCESS', false, true);
        }
        if (!list.children.length) root.createEl('p', { text: '暂无符合筛选条件的作品或本地笔记。历史基线不计入新发现数量。' });
        this.account = state.accountId;
        if (focused) Array.from(root.querySelectorAll<HTMLElement>('[data-control]')).find(el => el.getAttribute('data-control') === focused)?.focus();
    }
    private async openFolder(file: TAbstractFile) {
        const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
        const view = leaf?.view as unknown as { revealInFolder?: (file: TAbstractFile) => void };
        if (view?.revealInFolder) { await this.app.workspace.revealLeaf(leaf); view.revealInFolder(file); }
        else new FolderPickerModal(this.app, file.parent?.path || '', () => {}).open();
    }
}
