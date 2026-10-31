import { ItemView, Modal, Notice, Setting, type WorkspaceLeaf, type TAbstractFile } from 'obsidian';
import type BijiSyncPlugin from './main';
import { action } from './subscription-settings';
import { FolderPickerModal } from './settings';
import type { IndexConflict } from './subscription-archive';
import { isArchiveRecord, positiveId } from './subscriptions';
import { formatBeijingDateTime } from './date-format';
import { formatSubscriptionDate, subscriptionPresentation, subscriptionWorkMeta } from './subscription-presentation';
import { subscriptionPlatformLabel } from './subscription-settings-page';

export const SUBSCRIPTION_VIEW_TYPE = 'clip2md-blogger-subscriptions';
const localStatuses: Record<string, string> = { pending: '待同步', synced: '已同步', excluded: '已排除', conflict: '批注冲突', images: '图片失败 / 待处理', error: '本地同步失败' };
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
    private blogger = ''; private platform = ''; private kind = ''; private localStatus = ''; private cloudStatusFilter = '';
    private mode: 'attention' | 'all' = 'attention';
    private search = '';
    private visibleCount = 50;
    private subscriptionDetailsOpen = false;
    private managementOpen = false;
    private filtersOpen = false;
    private expandedTitles = new Set<string>();
    private openMenus = new Set<string>();
    private account?: string;
    constructor(leaf: WorkspaceLeaf, private plugin: BijiSyncPlugin) { super(leaf); }
    getViewType() { return SUBSCRIPTION_VIEW_TYPE; }
    getDisplayText() { return '博主订阅'; }
    getIcon() { return 'rss'; }
    async onOpen() {
        this.render(); await this.plugin.refreshSubscriptionSnapshot(); await this.plugin.rebuildSubscriptions(); this.render();
    }
    render() {
        const scroll = this.contentEl.scrollTop;
        const active = this.contentEl.contains(document.activeElement) ? document.activeElement : null;
        const focused = active?.getAttribute('data-control');
        const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd, active.selectionDirection] as const : null;
        const state = this.plugin.getSubscriptionState(), snapshot = state.unverified ? undefined : state.snapshot;
        if (state.unverified || this.account !== state.accountId) {
            if (this.account) {
                this.blogger = this.platform = this.kind = this.localStatus = this.cloudStatusFilter = '';
                this.search = ''; this.mode = 'attention'; this.visibleCount = 50;
            }
        }
        const root = this.contentEl; root.empty(); root.addClass('clip2md-subscription-view');
        const header = root.createDiv({ cls: 'clip2md-subscription-header' });
        const heading = header.createDiv();
        heading.createEl('h2', { text: '博主订阅' });
        heading.createEl('p', { text: snapshot ? `${snapshot.items.length} 位博主 · ${formatBeijingDateTime(snapshot.fetchedAt)}` : '连接账号后查看订阅和本地笔记', cls: 'setting-item-description' });
        const tools = header.createDiv({ cls: 'clip2md-subscription-actions clip2md-subscription-panel-actions' });
        action(tools, '立即同步', () => this.plugin.syncNow()).classList.add('mod-cta');
        action(tools, '刷新订阅', async () => { await this.plugin.refreshSubscriptionSnapshot(); await this.plugin.rebuildSubscriptions(); this.render(); });
        const moreTools = header.createEl('details', { cls: 'clip2md-subscription-more' });
        moreTools.open = this.managementOpen;
        moreTools.addEventListener('toggle', () => { this.managementOpen = moreTools.open; });
        moreTools.createEl('summary', { text: '管理' });
        const secondary = moreTools.createDiv({ cls: 'clip2md-subscription-more-actions' });
        action(secondary, '订阅设置', () => this.plugin.openSettingsTab());
        action(secondary, '网页管理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
        if (this.plugin.subscriptionError) root.createEl('p', { text: this.plugin.subscriptionError, attr: { role: 'status' } });
        if (!snapshot && !this.plugin.subscriptionError) root.createEl('p', { text: '暂无已验证的订阅列表，请刷新或打开插件设置绑定账号。', cls: 'clip2md-subscription-empty-state', attr: { role: 'status' } });
        for (const error of this.plugin.subscriptionArchiveErrors) root.createEl('p', { text: error, cls: 'clip2md-subscription-error' });
        for (const conflict of this.plugin.subscriptionIndexConflicts || []) action(root,
            `查看索引冲突 #${conflict.id}`, () => { new IndexConflictModal(this.plugin, conflict).open(); });
        const viewTools = root.createDiv({ cls: 'clip2md-subscription-view-tools' });
        const modes = viewTools.createDiv({ cls: 'clip2md-segmented-control', attr: { role: 'group', 'aria-label': '作品范围' } });
        for (const [mode, label] of [['attention', '待处理'], ['all', '全部']] as const) {
            const button = modes.createEl('button', { text: label, attr: { type: 'button', 'aria-pressed': String(this.mode === mode), 'data-control': `mode-${mode}` } });
            button.toggleClass('is-active', this.mode === mode);
            button.addEventListener('click', () => { this.mode = mode; this.visibleCount = 50; this.render(); });
        }
        const filterDetails = viewTools.createEl('details', { cls: 'clip2md-filter-disclosure' });
        filterDetails.createEl('summary', { text: '更多筛选' });
        filterDetails.open = this.filtersOpen;
        filterDetails.addEventListener('toggle', () => { this.filtersOpen = filterDetails.open; });
        const filters = filterDetails.createDiv({ cls: 'clip2md-subscription-filter-panel' });
        const filter = (label: string, value: string, items: Array<[string, string]>, set: (v: string) => void) => {
            if (value && !items.some(([key]) => key === value)) { value = ''; set(''); }
            new Setting(filters).setName(label).addDropdown(select => {
                select.addOption('', '全部'); for (const [key, name] of items) select.addOption(key, name);
                select.setValue(value).onChange(v => { set(v); this.render(); });
                select.selectEl.setAttribute('data-control', label === '本地状态' ? '状态' : label);
                select.selectEl.setAttribute('aria-label', label);
            });
        };
        filter('博主', this.blogger, (snapshot?.items || []).map(s => [String(s.id), s.name || s.profile?.nickname || s.blogger_id]), v => { this.blogger = v; });
        filter('平台', this.platform, [...new Set((snapshot?.items || []).map(s => s.platform))].map(p => [p, subscriptionPlatformLabel(p)]), v => { this.platform = v; });
        filter('文档类型', this.kind, [['work', '作品'], ['comment_supplement', '评论补充'], ['daily_report', '日报']], v => { this.kind = v; });
        filter('本地状态', this.localStatus, Object.entries(localStatuses), v => { this.localStatus = v; });
        filter('云端状态', this.cloudStatusFilter, [['cloud-pending', '云端处理中'], ['cloud-failed', '云端失败'], ['cloud-none', '云端未剪藏'], ['cloud-unknown', '未知状态'], ['cloud-success', '云端已完成']], v => { this.cloudStatusFilter = v; });
        const subscriptionDetails = root.createEl('details', { cls: 'clip2md-subscription-directory' });
        subscriptionDetails.open = this.subscriptionDetailsOpen;
        subscriptionDetails.addEventListener('toggle', () => { this.subscriptionDetailsOpen = subscriptionDetails.open; });
        subscriptionDetails.createEl('summary', { text: '订阅与扫描详情' });
        for (const sub of snapshot?.items || []) {
            if (this.blogger && String(sub.id) !== this.blogger || this.platform && sub.platform !== this.platform) continue;
            const info = subscriptionDetails.createDiv({ cls: 'clip2md-subscription-directory-item' });
            info.createEl('strong', { text: `${sub.name || sub.profile?.nickname || sub.blogger_id} · ${subscriptionPlatformLabel(sub.platform)}` });
            const scan = sub.last_scan?.status === 'SUCCESS' ? '扫描正常' : sub.last_scan ? `扫描 ${sub.last_scan.status}` : '尚未扫描';
            info.createEl('p', { text: `到期 ${formatSubscriptionDate(sub.ends_at)} · ${scan} · 新发现 ${sub.last_scan?.new_work_count ?? 0} 篇` });
        }
        const listTools = root.createDiv({ cls: 'clip2md-subscription-list-tools' });
        const search = listTools.createEl('input', { attr: { type: 'search', placeholder: '搜索作品标题', 'aria-label': '搜索作品标题', 'data-control': '作品标题搜索' } });
        search.value = this.search;
        search.addEventListener('input', () => { this.search = search.value; this.visibleCount = 50; this.render(); });
        const resultCount = listTools.createSpan({ cls: 'clip2md-filter-count', text: '正在计算结果…' });
        const list = root.createEl('ul', { cls: 'clip2md-subscription-list', attr: { 'aria-busy': 'false' } });
        const displayed = new Set<number>();
        let resultTotal = 0;
        let truncated = false;
        const row = (id: number | null, kind: string, subId: number | undefined, platform: string | undefined,
            title: string, url: string, cloud: string | null, baseline = false, localOnly = false) => {
            if (id !== null && displayed.has(id)) return;
            const note = this.plugin.getSubscriptionNotes().find(n => n.metadata.task_id === id);
            const ignored = id !== null && this.plugin.syncService.getIgnoredTaskIds().includes(id);
            const local = ignored ? 'excluded' : id !== null ? state.statuses[id]?.status || (note ? 'synced' : 'pending') : '';
            const presentation = subscriptionPresentation({ cloud, local, baseline, localOnly });
            const blogger = (snapshot?.items || []).find(item => item.id === subId);
            const searchable = `${title} ${blogger?.name || blogger?.profile?.nickname || ''}`.toLocaleLowerCase();
            if (this.search && !searchable.includes(this.search.trim().toLocaleLowerCase())) return;
            if (this.blogger && String(subId) !== this.blogger || this.platform && platform !== this.platform
                || this.kind && kind !== this.kind || this.localStatus && presentation.local !== this.localStatus
                || this.cloudStatusFilter && presentation.cloudFilter !== this.cloudStatusFilter) return;
            if (this.mode === 'attention' && !presentation.needsAttention) return;
            if (id !== null) displayed.add(id);
            resultTotal++;
            if (resultTotal > this.visibleCount) { truncated = true; return; }
            const rowKey = id !== null ? `task:${id}:${kind}` : `work:${subId}:${platform}:${url}`;
            const li = list.createEl('li', { cls: 'clip2md-subscription-item' });
            const body = li.createDiv({ cls: 'clip2md-subscription-item-body' });
            const titleButton = body.createEl('button', { cls: 'clip2md-subscription-item-title', attr: { type: 'button', 'aria-expanded': String(this.expandedTitles.has(rowKey)), 'aria-label': `展开或收起标题：${title}` } });
            titleButton.createEl('strong', { text: title });
            titleButton.addEventListener('click', () => {
                const expanded = titleButton.getAttribute('aria-expanded') === 'true';
                titleButton.setAttribute('aria-expanded', String(!expanded));
                if (expanded) this.expandedTitles.delete(rowKey); else this.expandedTitles.add(rowKey);
            });
            const meta = body.createDiv({ cls: 'clip2md-subscription-item-meta' });
            if (blogger) meta.createSpan({ text: blogger.name || blogger.profile?.nickname || blogger.blogger_id });
            meta.createSpan({ text: subscriptionWorkMeta(platform, kind) });
            if (presentation.detail) meta.createSpan({ text: presentation.detail });
            meta.createSpan({ text: presentation.label, cls: `clip2md-status-badge is-${presentation.tone}`, attr: { role: 'status' } });
            if (id !== null && state.statuses[id]?.message) body.createEl('p', { text: state.statuses[id].message, cls: 'clip2md-subscription-item-message' });
            const actions = li.createDiv({ cls: 'clip2md-subscription-actions clip2md-subscription-item-actions' });
            const more = li.createEl('details', { cls: 'clip2md-subscription-item-more' });
            more.createEl('summary', { text: '更多', attr: { 'aria-label': `更多操作：${title}` } });
            more.open = this.openMenus.has(rowKey);
            more.addEventListener('toggle', () => { if (more.open) this.openMenus.add(rowKey); else this.openMenus.delete(rowKey); });
            const secondary = more.createDiv({ cls: 'clip2md-subscription-item-more-actions' });
            const retry = () => {
                if (id !== null && cloud === 'SUCCESS' && !ignored && presentation.local !== 'excluded')
                    action(actions, '重新同步', () => this.plugin.retrySubscriptionTask(id));
            };
            if (id !== null && presentation.local === 'conflict') action(actions, '处理冲突', () => { new SubscriptionConflictModal(this.plugin, id).open(); });
            else if (presentation.local === 'error' || presentation.local === 'images') retry();
            else if (presentation.cloudFilter === 'cloud-failed' || presentation.cloudFilter === 'cloud-none')
                action(actions, '前往网页处理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
            else if (note) action(actions, '打开笔记', () => this.app.workspace.getLeaf(false).openFile(note.file));
            else if (presentation.cloudFilter === 'cloud-unknown') action(actions, '前往网页处理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
            else if (id !== null && presentation.needsAttention) retry();
            if (note) {
                action(secondary, '打开笔记', () => this.app.workspace.getLeaf(false).openFile(note.file));
                action(secondary, '打开目录', () => this.openFolder(note.file));
                action(secondary, '打开索引', async () => {
                    const index = this.app.vault.getMarkdownFiles().find(f => {
                        const frontmatter: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter;
                        const meta: unknown = isArchiveRecord(frontmatter) ? frontmatter.clip2md_index : undefined;
                        return isArchiveRecord(meta) && meta.account_id === state.accountId && positiveId(meta.subscription_id) && meta.subscription_id === subId;
                    });
                    if (index) await this.app.workspace.getLeaf(false).openFile(index); else new Notice('尚未生成博主索引');
                });
            }
            if (/^https?:\/\//.test(url)) action(secondary, '打开原文', () => { window.open(url, '_blank'); });
                if (id !== null && presentation.local !== 'conflict' && !['error', 'images'].includes(presentation.local)) {
                if (id !== null && cloud === 'SUCCESS' && !ignored && presentation.local !== 'excluded')
                    action(secondary, '重新同步', () => this.plugin.retrySubscriptionTask(id));
            }
            if (id !== null && presentation.local === 'conflict') action(secondary, '比较并处理冲突', () => { new SubscriptionConflictModal(this.plugin, id).open(); });
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
        const hasCustomFilters = !!(this.search || this.blogger || this.platform || this.kind || this.localStatus || this.cloudStatusFilter);
        const clearFilters = () => {
            this.search = ''; this.blogger = this.platform = this.kind = this.localStatus = this.cloudStatusFilter = '';
            this.visibleCount = 50; this.render();
        };
        if (hasCustomFilters) {
            const clear = action(listTools, '清除筛选', clearFilters);
            clear.classList.add('clip2md-clear-filters'); clear.dataset.control = 'clear-filters';
        }
        resultCount.textContent = this.visibleCount < resultTotal ? `显示 ${list.children.length} / ${resultTotal}` : `${resultTotal} 条结果`;
        if (truncated) {
            const loadMore = root.createDiv({ cls: 'clip2md-load-more' });
            const button = loadMore.createEl('button', { text: `加载更多（剩余 ${resultTotal - list.children.length} 条）`, attr: { type: 'button', 'data-control': 'load-more' } });
            button.addEventListener('click', () => { this.visibleCount += 50; this.render(); });
        }
        if (!resultTotal) {
            const empty = root.createDiv({ cls: 'clip2md-empty-state clip2md-subscription-empty-state' });
            empty.createEl('strong', { text: snapshot?.works?.length ? this.mode === 'attention' && !hasCustomFilters ? '没有待处理的作品' : '没有符合筛选条件的作品' : '还没有可显示的作品' });
            empty.createEl('p', { text: snapshot?.works?.length ? '可切换全部作品，或调整搜索和筛选条件。' : '先在网页管理中添加博主，或刷新订阅列表。' });
            if (snapshot?.works?.length) {
                action(empty, hasCustomFilters ? '清除筛选' : '查看全部', () => {
                    if (hasCustomFilters) clearFilters();
                    else { this.mode = 'all'; this.visibleCount = 50; this.render(); }
                });
            }
            else action(empty, '打开网页管理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
        }
        this.account = state.accountId;
        if (focused) {
            const target = Array.from(root.querySelectorAll<HTMLElement>('[data-control]')).find(el => el.getAttribute('data-control') === focused);
            target?.focus({ preventScroll: true });
            if (target instanceof HTMLInputElement && selection && selection[0] !== null && selection[1] !== null)
                target.setSelectionRange(selection[0], selection[1], selection[2] || undefined);
        }
        root.scrollTop = scroll;
    }
    private async openFolder(file: TAbstractFile) {
        const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
        const view = leaf?.view as unknown as { revealInFolder?: (file: TAbstractFile) => void };
        if (view?.revealInFolder) { await this.app.workspace.revealLeaf(leaf); view.revealInFolder(file); }
        else new FolderPickerModal(this.app, file.parent?.path || '', () => {}).open();
    }
}
