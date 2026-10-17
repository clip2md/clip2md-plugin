import { Notice, Setting, SettingPage } from 'obsidian';
import type BijiSyncPlugin from './main';
import { archiveConfig, type ArchiveConfig } from './subscriptions';
import { action, folderSetting, validateConfig } from './subscription-settings';

/** Account-scoped drafts live only while this page is open. No data writes on input. */
export class SubscriptionSettingsPage extends SettingPage {
    private draft?: ArchiveConfig;
    private baseline = '';
    private account?: string;
    private generation = -1;
    private search = '';
    private opened = new Set<string>();
    private saving = false;
    private active = false;
    private unsubscribe?: () => void;
    private notice = '';

    constructor(private readonly plugin: BijiSyncPlugin) { super(); this.title = '博主订阅'; }

    display(): void {
        const first = !this.active;
        this.active = true;
        this.unsubscribe ??= this.plugin.subscribeSubscriptionChanges(() => { if (this.active) this.render(); });
        this.render();
        if (first) void this.plugin.refreshSubscriptionSnapshot();
    }
    hide(): void {
        this.active = false;
        this.unsubscribe?.(); this.unsubscribe = undefined;
        this.draft = undefined;
        super.hide();
    }
    private render(): void {
        const generation = this.plugin.getCredentialGeneration();
        const state = this.plugin.getSubscriptionState();
        const root = this.containerEl;
        const focused = root.contains(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement : null;
        const control = focused?.getAttribute('data-control');
        const selection = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const : null;
        const scroll = root.scrollTop;
        const identityChanged = generation !== this.generation || this.account !== state.accountId || state.unverified;
        if (identityChanged) {
            this.draft = undefined; this.baseline = ''; this.search = ''; this.opened.clear(); this.notice = '';
        }
        this.generation = generation; this.account = state.accountId;
        const verified = !!state.accountId && !state.unverified && !!this.plugin.settings.apiKey;
        if (verified && !this.draft) {
            this.draft = archiveConfig(this.plugin.getSubscriptionConfig());
            this.baseline = JSON.stringify(this.draft);
        }
        root.empty(); root.addClass('clip2md-subscription-settings');
        root.setAttribute('aria-busy', String(this.saving || this.plugin.subscriptionLoading));
        new Setting(root).setName('订阅概况').setHeading();
        const status = !this.plugin.settings.apiKey ? '未绑定：请先绑定当前设备'
            : this.plugin.subscriptionErrorKind === 'authentication' ? '认证失败：请重新验证当前凭证'
            : this.plugin.subscriptionErrorKind === 'unsupported' ? '服务不兼容：服务器暂不支持订阅面板'
            : this.plugin.subscriptionLoading ? '加载中：正在获取当前账号订阅'
            : !verified ? '待验证：请刷新以确认当前账号'
            : this.plugin.subscriptionError ? '离线缓存：显示此前验证成功的资料'
            : !state.snapshot?.items.length ? '无订阅：可前往网页管理'
            : '正常已加载';
        root.createEl('p', { text: status, attr: { role: 'status', 'aria-live': 'polite' } });
        if (this.plugin.subscriptionError) root.createEl('p', { text: this.plugin.subscriptionError, cls: 'clip2md-subscription-error' });
        const tools = root.createDiv({ cls: 'clip2md-subscription-actions' });
        const refresh = action(tools, '刷新订阅', () => this.plugin.refreshSubscriptionSnapshot());
        refresh.disabled = this.plugin.subscriptionLoading || !this.plugin.settings.apiKey || this.saving;
        action(tools, '打开作品面板', () => this.plugin.openSubscriptionPanel());
        action(tools, '网页管理', () => { window.open('https://clip2.md/app/bloggers', '_blank'); });
        if (!verified || !this.draft) return;
        const config = this.draft;
        const renderedAccount = state.accountId;
        root.createEl('p', { text: `当前账号：${state.accountId} · 订阅 ${state.snapshot?.items.length || 0} 位博主` });
        if (state.snapshot) root.createEl('p', { text: `列表获取时间：${state.snapshot.fetchedAt}`, cls: 'setting-item-description' });
        const draftStatus = root.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
        const changed = () => { draftStatus.textContent = JSON.stringify(config) === this.baseline ? '配置已保存' : '未保存'; };
        changed();
        // A picker callback may outlive the page or a credential change.
        const canEdit = () => this.active && !this.saving && generation === this.plugin.getCredentialGeneration()
            && !this.plugin.getSubscriptionState().unverified && renderedAccount === this.plugin.getSubscriptionState().accountId;
        const toggle = (parent: HTMLElement, name: string, value: boolean, set: (next: boolean) => void) => {
            new Setting(parent).setName(name).addToggle(input => {
                input.setValue(value).setDisabled(this.saving).onChange(next => { if (canEdit()) { set(next); changed(); } });
                input.toggleEl.setAttribute('aria-label', name);
                input.toggleEl.setAttribute('data-control', name);
            });
        };
        const folder = (parent: HTMLElement, name: string, value: string, set: (next: string) => void) =>
            folderSetting(parent, this.plugin, name, value, next => { set(next); changed(); }, canEdit);
        new Setting(root).setName('同步范围').setDesc('仅控制当前知识库的同步，关闭不会取消云端订阅或删除已有笔记。').setHeading();
        const search = root.createEl('input', { attr: { type: 'search', 'aria-label': '搜索博主', 'data-control': '搜索博主', placeholder: '搜索博主或平台' } });
        search.value = this.search;
        search.addEventListener('input', () => { this.search = search.value; this.render(); });
        const items = state.snapshot?.items || [];
        const visible = items.filter(sub => `${sub.name || sub.profile.nickname || sub.blogger_id} ${sub.platform}`.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()));
        for (const sub of visible) {
            const name = sub.name || sub.profile.nickname || sub.blogger_id;
            toggle(root, `${name} · ${sub.platform}`, config.bloggers[sub.id]?.enabled !== false, next => {
                config.bloggers[sub.id] = { ...config.bloggers[sub.id], enabled: next };
            });
        }
        if (!visible.length) root.createEl('p', { text: '暂无符合条件的博主。' });
        const section = (name: string) => {
            const details = root.createEl('details'); details.createEl('summary', { text: name });
            details.open = this.opened.has(name);
            details.addEventListener('toggle', () => { if (details.open) this.opened.add(name); else this.opened.delete(name); });
            return details;
        };
        const folders = section('归档目录');
        toggle(folders, '订阅内容分目录', config.enabled, next => { config.enabled = next; });
        folder(folders, '博主目录模板', config.folderTemplate, next => { config.folderTemplate = next; });
        folders.createEl('p', { text: '支持 {{platform}}、{{blogger_name}}、{{blogger_id}}、{{subscription_id}}。分目录关闭时沿用普通目录；目录变化仅影响新文件。', cls: 'setting-item-description' });
        toggle(folders, '自动生成博主索引', config.indexEnabled, next => { config.indexEnabled = next; });
        for (const sub of visible) folder(folders, `${sub.name || sub.profile.nickname || sub.blogger_id} #${sub.id} 指定目录（留空跟随模板）`, config.bloggers[sub.id]?.folder || '', next => {
            config.bloggers[sub.id] = { ...config.bloggers[sub.id], folder: next };
        });
        const preview = folders.createEl('pre', { cls: 'clip2md-subscription-preview', attr: { 'aria-live': 'polite' } });
        action(folders, '预览目录', () => { validateConfig(this.plugin, config); preview.textContent = this.plugin.previewSubscriptionFolders(config); });
        const reports = section('日报');
        toggle(reports, '同步已有日报笔记', config.reportsEnabled, next => { config.reportsEnabled = next; });
        folder(reports, '日报目录', config.reportFolder, next => { config.reportFolder = next; });
        const buttons = root.createDiv({ cls: 'clip2md-subscription-actions' });
        const canStillDisplay = () => generation === this.plugin.getCredentialGeneration() && renderedAccount === this.plugin.getSubscriptionState().accountId
            && !this.plugin.getSubscriptionState().unverified && this.active;
        const save = action(buttons, '保存订阅配置', async () => {
            if (!canEdit()) return;
            validateConfig(this.plugin, config);
            const submitted = archiveConfig(config), account = this.account;
            this.saving = true; this.notice = ''; this.render();
            try {
                await this.plugin.updateSubscriptionConfig(submitted, account, generation);
                if (canStillDisplay()) {
                    this.draft = archiveConfig(submitted); this.baseline = JSON.stringify(this.draft);
                    this.notice = '订阅配置已保存，仅影响新文件；点击同步应用同步范围';
                    new Notice(this.notice);
                }
            } catch (error) {
                if (canStillDisplay()) this.notice = error instanceof Error ? error.message : '保存失败，请重试';
            } finally { this.saving = false; if (this.active) this.render(); }
        });
        save.disabled = this.saving;
        const reset = action(buttons, '重置', () => { if (canEdit()) { this.draft = undefined; this.notice = ''; this.render(); } });
        reset.disabled = this.saving;
        if (this.notice) root.createEl('p', { text: this.notice, attr: { role: 'status', 'aria-live': 'polite' } });
        if (control && !identityChanged) {
            const target = Array.from(root.querySelectorAll<HTMLElement>('[data-control]')).find(el => el.getAttribute('data-control') === control);
            target?.focus();
            if (target instanceof HTMLInputElement && selection && selection[0] !== null && selection[1] !== null) target.setSelectionRange(selection[0], selection[1], selection[2] || undefined);
        }
        root.scrollTop = scroll;
    }
}
