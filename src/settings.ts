import { App, Modal, Notice, Platform, PluginSettingTab, Setting, SettingPage, TFolder } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type BijiSyncPlugin from './main';
import { DeviceBindingClient, DeviceBindingError, DeviceBindingSession } from './binding';
import { NoteContentSettings, type NoteContentViewState } from './note-content-settings';
import { validateCustomTitle, type TitleMode } from './note-title';
import { installButtonClickGuard } from './button-guard';
import type { ArchiveConfig } from './subscriptions';
import { DesktopSettingsPage } from './desktop-settings-page';
import { SubscriptionSettingsPage } from './subscription-settings-page';
import { CLIP2MD_USAGE_DOC_URL } from './config';

export type SyncContentMode = 'full' | 'note' | 'source';
export type SyncTrigger = 'manual' | 'scheduled' | 'startup' | 'onboarding';
export type SyncRuntimeState = 'idle' | 'syncing' | 'success' | 'partial' | 'error';
export type ImageMode = 'local' | 'disabled';
export type MergeMode = 'none' | 'daily';

export interface SyncRunSummary {
    startedAt: string;
    finishedAt: string;
    trigger: SyncTrigger;
    outcome: 'success' | 'partial' | 'failed';
    pages: number;
    processed: number;
    succeeded: number;
    pending: number;
    skipped: number;
    ignored?: number;
    failed: number;
    ackBlockedCount?: number;
    ackBlockedReasons?: string[];
    errorMessage?: string;
}

export interface BijiSyncSettings {
    subscriptionAccounts?: Record<string, ArchiveConfig>;
    apiKey: string;
    credentialId?: number;
    credentialName?: string;
    installationId: string;
    settingsSchemaVersion: number;
    syncInterval: number;
    syncOnStart: boolean;
    preventReimportAfterLocalRemoval: boolean;
    targetFolder: string;
    commentFolder?: string;
    sourcePropertiesTemplateInitialized?: boolean;
    filenameTemplate: string;
    filenameDateFormat: string;
    titleMode?: TitleMode;
    customTitleTemplate?: string;
    template: string;
    frontmatterTemplate: string;
    dailyMergeFrontmatterTemplate: string;
    syncContentMode: SyncContentMode;
    imageMode: ImageMode;
    imageFolder: string;
    mergeMode: MergeMode;
    lastSyncSummary?: SyncRunSummary;
}

interface OnboardingDraft {
    apiKey: string;
    targetFolder: string;
}

const SYNC_INTERVAL_OPTIONS = [
    { value: '0', label: '仅手动' },
    { value: '5', label: '5 分钟' },
    { value: '15', label: '15 分钟' },
    { value: '30', label: '30 分钟' },
    { value: '60', label: '1 小时' },
    { value: '180', label: '3 小时' },
    { value: '360', label: '6 小时' },
    { value: '720', label: '12 小时' },
    { value: '1440', label: '24 小时' },
];

const FOLDER_PRESETS = [
    { label: '全部放在一个目录', targetFolder: 'Clip2MD', filenameTemplate: '{{created_date}}-{{note_title}}' },
    { label: '按日期', targetFolder: 'Clip2MD/{{created_date}}', filenameTemplate: '{{note_title}}' },
    { label: '按来源/日期', targetFolder: 'Clip2MD/{{source}}/{{created_date}}', filenameTemplate: '{{note_title}}' },
];

export const LEGACY_TAGGED_FRONTMATTER_TEMPLATE = `---
title: "{{title}}"
date: "{{source_date}}"
source: "{{source}}"
tags: {{tags}}
task_id: {{task_id}}
---`;

export const DEFAULT_FRONTMATTER_TEMPLATE = `---
title: "{{title}}"
date: "{{source_date}}"
tags: {{tags}}
url: "{{url}}"
task_id: {{task_id}}
---`;

export const NEW_DEFAULT_FRONTMATTER_TEMPLATE = `---
title: "{{note_title}}"
date: "{{source_date}}"
tags: {{tags}}
url: "{{url}}"
task_id: {{task_id}}
---`;
export const NEW_DEFAULT_FILENAME_TEMPLATE = '{{created_date}}-{{note_title}}';
export const IMAGE_FOLDER_PLACEHOLDER = '默认：主笔记目录/_assets';

export const DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE = `---
title: "{{title}}"
date: "{{date}}"
tags: {{tags}}
task_count: {{task_count}}
task_ids: {{task_ids}}
tasks:
{{tasks}}
---`;

// Used only to upgrade installations that still have the v1.0.3 built-in
// template saved in their data.json. Custom templates are left untouched.
export const LEGACY_DEFAULT_FRONTMATTER_TEMPLATE = `---
title: "{{title}}"
date: "{{source_date}}"
source: "{{source}}"
task_id: {{task_id}}
---`;

class Clip2MDSettingsPage extends SettingPage {
    constructor(
        private readonly renderContent: (containerEl: HTMLElement) => void,
        private readonly cleanup: () => void,
    ) {
        super();
        this.title = 'Clip2MD 设置';
    }

    display(): void {
        this.renderContent(this.containerEl);
    }

    hide(): void {
        this.cleanup();
        super.hide();
    }
}

export class BijiSyncSettingTab extends PluginSettingTab {
    plugin: BijiSyncPlugin;
    private onboardingDraft: OnboardingDraft | null = null;
    private noteContent: NoteContentSettings | null = null;
    private noteContentState: NoteContentViewState = {};
    private folderSettingEl: HTMLElement | null = null;
    private bindingMode: 'qr' | 'manual' = 'qr';
    private showBindingForExistingKey = false;
    private confirmLegacyCleanup = false;
    private bindingClient = new DeviceBindingClient();
    private bindingSession: DeviceBindingSession | null = null;
    private bindingQrDataUrl = '';
    private qrLoadInFlight = false;
    private qrUnavailableForCode = '';
    private bindingState: 'idle' | 'starting' | 'waiting' | 'approving' | 'error' | 'expired' = 'idle';
    private bindingMessage = '';
    private testingConnection = false;
    private advancedOpen = false;
    private settingsSectionsOpen = new Set<string>(['同步规则', '保存位置']);
    private bindingRenderKey = '';
    private launchUrl = '';
    private launchState: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
    private launchMessage = '';
    private showingInvalidOnboarding = false;
    private activeContainerEl: HTMLElement | null = null;
    private accountCleanup?: () => void;

    constructor(app: App, plugin: BijiSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private runAsync(task: () => Promise<void>): void {
        void task().catch(error => this.plugin.handleConnectionError(error));
    }

    async testConnection(btnEl: HTMLElement): Promise<void> {
        if (this.testingConnection) return;
        this.testingConnection = true;
        const origText = btnEl.textContent;
        btnEl.textContent = '测试中...';
        btnEl.toggleClass('is-loading', true);
        btnEl.setAttribute('aria-busy', 'true');
        if (btnEl.instanceOf(HTMLButtonElement)) btnEl.disabled = true;

        try {
            const { apiKey } = this.plugin.settings;
            if (!apiKey) {
                new Notice('Clip2MD: 请先填写 API Key');
                return;
            }
            await this.plugin.verifyConnection();
            new Notice('Clip2MD: 连接成功，可以开始同步。', 5000);
            this.refresh();
        } catch (err) {
            this.plugin.handleConnectionError(err);
            this.refresh();
        } finally {
            this.testingConnection = false;
            btnEl.textContent = origText;
            btnEl.toggleClass('is-loading', false);
            btnEl.removeAttribute('aria-busy');
            if (btnEl.instanceOf(HTMLButtonElement)) btnEl.disabled = false;
            this.refresh();
        }
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [{
            type: 'page',
            name: 'Clip2MD 设置',
            desc: '网页剪藏、评论补充、图片本地化与自动同步',
            status: () => {
                const kind = this.plugin.getStatusSnapshot().kind;
                return kind === 'invalid' || kind === 'error' ? 'warning' : null;
            },
            page: () => new Clip2MDSettingsPage(
                containerEl => this.renderInto(containerEl),
                () => this.releaseActivePage(),
            ),
        }, {
            type: 'page', name: '博主订阅', desc: '订阅概况、同步范围、归档目录和日报',
            status: () => this.plugin.subscriptionError ? 'warning' : null,
            page: () => new SubscriptionSettingsPage(this.plugin),
        }, ...(Platform.isDesktopApp ? [{
            type: 'page' as const,
            name: '本地剪藏扩展',
            desc: '平台登录、素材能力、工具准备和本地重试',
            page: () => new DesktopSettingsPage(this.plugin),
        }] : [])];
    }

    refresh(): void {
        const container = this.activeContainerEl;
        if (!container) return;
        const status = this.plugin.getStatusSnapshot();
        const indicator = container.querySelector<HTMLElement>('.clip2md-status-indicator');
        if (indicator) { indicator.className = `clip2md-status-indicator is-${status.kind}`; indicator.textContent = status.label; }
        const summary = container.querySelector('.clip2md-status-summary');
        if (summary) summary.textContent = status.description;
        const sync = container.querySelector<HTMLButtonElement>('[data-clip2md-action="sync"]');
        if (sync) { sync.disabled = status.runtimeState === 'syncing'; sync.textContent = sync.disabled ? '同步中...' : '立即同步'; }
        const test = container.querySelector<HTMLButtonElement>('[data-clip2md-action="test"]');
        if (test) test.disabled = this.testingConnection || !this.plugin.settings.apiKey || status.runtimeState === 'syncing';
        const binding = container.querySelector<HTMLElement>('.clip2md-binding-region');
        const bindingKey = JSON.stringify([this.plugin.getDeviceBindingSession?.()?.device_code, this.plugin.getDeviceBindingMessage?.(), this.bindingQrDataUrl, this.bindingState, this.bindingMessage, this.launchState, this.launchMessage, this.qrUnavailableForCode]);
        if (binding && this.bindingMode === 'qr' && bindingKey !== this.bindingRenderKey) {
            this.bindingRenderKey = bindingKey;
            const scroll = container.scrollTop;
            binding.empty();
            this.renderQrOnboarding(binding);
            container.scrollTop = scroll;
        }
    }


    private renderInto(containerEl: HTMLElement): void {
        this.activeContainerEl = containerEl;
        installButtonClickGuard(containerEl);
        containerEl.addClass('clip2md-settings');
        containerEl.toggleClass('clip2md-platform-mobile', Platform.isMobileApp);
        this.accountCleanup?.();
        containerEl.empty();
        this.noteContent?.dispose();
        this.noteContent = null;
        this.folderSettingEl = null;

        const status = this.plugin.getStatusSnapshot();
        this.renderStatusBar(containerEl, status);

        const apiKeyInvalid = status.kind === 'invalid';
        if (!this.plugin.settings.apiKey || apiKeyInvalid) {
            if (apiKeyInvalid && !this.showingInvalidOnboarding) {
                this.bindingMode = 'qr';
                this.onboardingDraft = {
                    apiKey: '',
                    targetFolder: this.plugin.settings.targetFolder || 'Clip2MD',
                };
            }
            this.showingInvalidOnboarding = apiKeyInvalid;
            this.renderOnboarding(containerEl, apiKeyInvalid);
            return;
        }

        if (this.showBindingForExistingKey) {
            new Setting(containerEl).setName('重新绑定此设备').setHeading();
            new Setting(containerEl).setName('返回设置').addButton(btn => btn.setButtonText('返回').onClick(() => {
                this.showBindingForExistingKey = false;
                this.refreshDisplay();
            }));
            this.renderQrOnboarding(containerEl.createDiv({ cls: 'clip2md-binding-region' }));
            return;
        }

        this.showingInvalidOnboarding = false;
        this.renderBasicSettings(containerEl);
        this.renderAdvancedSettings(containerEl);
    }

    private refreshDisplay(): void {
        this.renderInto(this.activeContainerEl ?? this.containerEl);
    }

    private releaseActivePage(): void {
        this.accountCleanup?.();this.accountCleanup=undefined;
        this.plugin.timers.clearGroup('settings-ui');
        this.noteContent?.dispose();
        this.noteContent = null;
        this.activeContainerEl = null;
    }

    onAppVisibilityChange(visible: boolean): void {
        if (visible && this.activeContainerEl) this.refresh();
    }

    onDeviceBindingFinished(): void {
        this.showBindingForExistingKey = false;
        this.resetBindingSession();
        if (this.activeContainerEl) this.refreshDisplay();
    }
    private renderStatusBar(containerEl: HTMLElement, status = this.plugin.getStatusSnapshot()) {
        const wrap = containerEl.createDiv({ cls: 'clip2md-status-bar' });
        const summary = wrap.createDiv({ cls: 'clip2md-status-main' });
        const account = summary.createDiv({ cls: 'clip2md-status-account' });
        this.accountCleanup = this.plugin.renderCloudAccount?.(account);
        const state = summary.createDiv({ cls: 'clip2md-status-line' });
        state.createSpan({
            cls: `clip2md-status-indicator is-${status.kind}`,
            text: status.label,
        });
        state.createSpan({
            cls: 'clip2md-status-summary',
            text: status.description,
        });

        const actions = wrap.createDiv({ cls: 'clip2md-status-actions' });
        const syncButton = actions.createEl('button', {
            text: status.runtimeState === 'syncing' ? '同步中...' : '立即同步',
            cls: 'mod-cta',
        });
        syncButton.dataset.clip2mdAction = 'sync';
        syncButton.toggleClass('clip2md-inline-button', true);
        syncButton.disabled = status.runtimeState === 'syncing';
        syncButton.addEventListener('click', () => {
            this.runAsync(async () => {
                await this.plugin.syncNow('manual');
                this.refresh();
            });
        });

    }

    private renderHelpActions(containerEl: HTMLElement): void {
        const actions = containerEl.createDiv({ cls: 'clip2md-help-actions' });
        actions.createEl('a', {
            text: '使用说明',
            href: CLIP2MD_USAGE_DOC_URL,
        });
        const copyButton = actions.createEl('button', {
            text: '复制给 AI Agent',
            cls: 'clip2md-inline-button',
        });
        copyButton.addEventListener('click', () => void this.copyUsageDocForAgent(copyButton));
    }

    private async copyUsageDocForAgent(button: HTMLButtonElement): Promise<void> {
        const prompt = `请先阅读 Clip2MD 产品使用说明，再根据说明回答我的问题：\n${CLIP2MD_USAGE_DOC_URL}`;
        try {
            if (!navigator.clipboard) throw new Error('clipboard_unavailable');
            await navigator.clipboard.writeText(prompt);
            new Notice('Clip2MD: AI Agent 使用说明链接已复制。', 3000);
            button.setText('已复制');
            this.plugin.timers.setTimeout(() => button.setText('复制给 AI Agent'), 2000, 'settings-ui');
        } catch {
            new Notice(`Clip2MD 使用说明：${CLIP2MD_USAGE_DOC_URL}`, 6000);
        }
    }

    private renderOnboarding(containerEl: HTMLElement, apiKeyInvalid = false) {
        new Setting(containerEl)
            .setName('开始设置')
            .setHeading();
        containerEl.createEl('p', {
            text: '使用微信扫码绑定，或切换为手动填写 API Key。',
            cls: 'setting-item-description',
        });
        const tabs = containerEl.createDiv({ cls: 'clip2md-binding-tabs' });
        const qrTab = tabs.createEl('button', { text: '微信扫码绑定' });
        const manualTab = tabs.createEl('button', { text: '手动填写 Key' });
        qrTab.toggleClass('is-active', this.bindingMode === 'qr');
        manualTab.toggleClass('is-active', this.bindingMode === 'manual');
        qrTab.addEventListener('click', () => {
            this.bindingMode = 'qr';
            this.refreshDisplay();
        });
        manualTab.addEventListener('click', () => {
            this.bindingMode = 'manual';
            this.refreshDisplay();
        });
        if (this.bindingMode === 'qr') {
            this.renderQrOnboarding(containerEl.createDiv({ cls: 'clip2md-binding-region' }));
        } else {
            this.renderManualOnboarding(containerEl, apiKeyInvalid);
        }
        const advanced = containerEl.createEl('details');
        advanced.open = this.advancedOpen;
        advanced.addEventListener('toggle', () => { this.advancedOpen = advanced.open; });
        advanced.createEl('summary', { text: '使用高级设置' });
        this.renderAdvancedSettings(advanced, true);
    }

    private renderQrOnboarding(containerEl: HTMLElement): void {
        const resumed = this.plugin.getDeviceBindingSession();
        if (resumed && !this.bindingSession && this.bindingState !== 'starting') this.bindingSession = resumed;
        if (!resumed && this.bindingSession) {
            this.bindingState = 'expired';
        }
        if (resumed && this.bindingState !== 'starting' && this.bindingState !== 'error'
            && !this.bindingQrDataUrl && !this.qrLoadInFlight
            && this.qrUnavailableForCode !== resumed.device_code) {
            this.qrLoadInFlight = true;
            void this.bindingClient.qrcode(resumed.device_code).then(data => {
                this.bindingQrDataUrl = data;
                this.refresh();
            }).catch(() => {
                this.qrUnavailableForCode = resumed.device_code;
                this.refresh();
            }).finally(() => { this.qrLoadInFlight = false; });
        }
        const card = containerEl.createDiv({ cls: 'clip2md-guide-card clip2md-binding-card' });
        card.createDiv({ text: '打开微信扫一扫，确认后自动完成绑定', cls: 'clip2md-binding-title' });
        if (this.bindingQrDataUrl) {
            card.createEl('img', {
                attr: { src: this.bindingQrDataUrl, alt: 'Clip2MD 小程序码' },
                cls: 'clip2md-binding-qrcode',
            });
        } else {
            card.createDiv({
                text: this.qrUnavailableForCode === resumed?.device_code
                    ? '小程序码不可用，请查看绑定码或等待插件完成'
                    : this.bindingState === 'error' ? '小程序码加载失败' : '正在生成小程序码…',
                cls: 'clip2md-binding-placeholder',
            });
        }
        if (this.bindingSession) {
            card.createEl('code', { text: this.bindingSession.user_code, cls: 'clip2md-binding-code' });
            const codeActions = card.createDiv({ cls: 'clip2md-binding-code-actions' });
            const copyButton = codeActions.createEl('button', { text: '复制绑定码', cls: 'clip2md-inline-button' });
            copyButton.addEventListener('click', () => void this.copyBindingCode(copyButton));
            if (Platform.isMobileApp) {
                const launchButton = card.createEl('button', {
                    text: this.launchState === 'loading' ? '正在准备小程序…' : '打开 Clip2MD 小程序',
                    cls: 'mod-cta clip2md-launch-button',
                });
                launchButton.disabled = this.launchState === 'loading';
                launchButton.addEventListener('click', () => void this.openMiniapp(launchButton));
                if (this.launchMessage) {
                    card.createEl('p', {
                        text: this.launchMessage,
                        cls: this.launchState === 'unavailable' ? 'clip2md-error-text' : 'setting-item-description',
                    });
                }
            }
        }
        card.createEl('p', {
            text: this.bindingState === 'error' ? this.bindingMessage
                : this.bindingSession ? this.plugin.getDeviceBindingMessage()
                : (this.bindingMessage || '小程序码 10 分钟内有效，请在手机端确认本次绑定。'),
            cls: this.bindingState === 'error' ? 'clip2md-error-text' : 'setting-item-description',
        });
        if (this.bindingState === 'error' || this.bindingState === 'expired') {
            const retry = card.createEl('button', { text: '重新生成', cls: 'mod-cta' });
            retry.addEventListener('click', () => void this.retryBinding());
        }
        if (!this.bindingSession && this.bindingState === 'idle') {
            void this.startBinding();
        }
    }

    private renderManualOnboarding(containerEl: HTMLElement, apiKeyInvalid = false): void {
        if (!this.onboardingDraft) {
            this.onboardingDraft = { apiKey: '', targetFolder: 'Clip2MD' };
        }
        const card = containerEl.createDiv({ cls: 'clip2md-guide-card' });
        const apiKeySetting = new Setting(card)
            .setName('API Key')
            .setDesc(apiKeyInvalid
                ? '原 API Key 已失效，请填写新的 Key。'
                : '从 Clip2MD API凭证管理页复制完整 Key')
            .addText(text => {
                text.setPlaceholder('clip2md_...')
                    .setValue(this.onboardingDraft?.apiKey ?? '')
                    .onChange(value => {
                        if (this.onboardingDraft) this.onboardingDraft.apiKey = value.trim();
                    });
                text.inputEl.type = 'password';
            })
            .addExtraButton(btn => btn.setIcon('external-link').setTooltip('管理 API凭证').onClick(() => this.plugin.openCredentialPage()));
        apiKeySetting.settingEl.toggleClass('clip2md-api-key-invalid', apiKeyInvalid);
        new Setting(card)
            .setName('目标文件夹')
            .setDesc('默认在 Vault 根目录创建 Clip2MD')
            .addText(text => text
                .setValue(this.onboardingDraft?.targetFolder ?? 'Clip2MD')
                .onChange(value => {
                    if (this.onboardingDraft) this.onboardingDraft.targetFolder = value.trim();
                }));
        new Setting(card)
            .setName('保存并连接')
            .setDesc('连接后点击“立即同步”创建目录并拉取内容')
            .addButton(btn => btn.setButtonText('保存并连接').setCta().onClick(() => {
                this.runAsync(async () => {
                    const draft = this.onboardingDraft ?? { apiKey: '', targetFolder: 'Clip2MD' };
                    if (!draft.apiKey || !this.plugin.validateTargetFolder(draft.targetFolder)) {
                        new Notice('Clip2MD: 请填写有效的 API Key 和目标文件夹。', 5000);
                        return;
                    }
                    btn.setDisabled(true);
                    try {
                        await this.plugin.applyOnboardingSettings(draft);
                        this.onboardingDraft = null;
                        this.refreshDisplay();
                    } finally {
                        btn.setDisabled(false);
                    }
                });
            }));
    }

    private async startBinding(): Promise<void> {
        this.bindingState = 'starting';
        this.bindingMessage = '正在创建安全绑定请求…';
        try {
            const session = await this.bindingClient.start(this.plugin.getBindingClientName());
            await this.plugin.beginDeviceBinding(session);
            this.bindingSession = session;
            this.launchUrl = '';
            this.launchState = 'idle';
            this.launchMessage = '';
            this.bindingState = 'waiting';
            this.bindingMessage = '请使用微信扫码，并在小程序中确认绑定。';
            this.qrLoadInFlight = true;
            this.refresh();
            try {
                this.bindingQrDataUrl = await this.bindingClient.qrcode(session.device_code);
            } catch (error) {
                this.bindingState = 'error';
                this.bindingMessage = error instanceof Error ? error.message : '小程序码加载失败，请重试。';
                this.refresh();
                return;
            } finally {
                this.qrLoadInFlight = false;
            }
            this.refresh();
        } catch (error) {
            this.bindingSession = null;
            this.bindingQrDataUrl = '';
            this.bindingState = 'error';
            this.bindingMessage = error instanceof Error ? error.message : '无法创建绑定请求。';
            this.refresh();
        }
    }

    private async retryBinding(): Promise<void> {
        if (this.bindingState === 'starting') return;
        const resumed = this.plugin.getDeviceBindingSession();
        this.resetBindingSession();
        if (resumed && resumed.expires_in > 0) {
            this.bindingSession = resumed;
            this.bindingState = 'waiting';
            this.plugin.resumeDeviceBinding();
            this.refresh();
            return;
        }
        try {
            if (resumed) await this.plugin.cancelDeviceBinding();
            await this.startBinding();
        } catch (error) {
            this.bindingState = 'error';
            this.bindingMessage = error instanceof Error ? error.message : '绑定重试失败，请稍后再试';
            this.plugin.resumeDeviceBinding();
            this.refresh();
        }
    }

    private resetBindingSession(): void {
        this.bindingSession = null;
        this.bindingQrDataUrl = '';
        this.qrUnavailableForCode = '';
        this.bindingState = 'idle';
        this.bindingMessage = '';
        this.launchUrl = '';
        this.launchState = 'idle';
        this.launchMessage = '';
    }

    private async copyBindingCode(button: HTMLButtonElement): Promise<void> {
        const code = this.bindingSession?.user_code;
        if (!code) return;
        try {
            if (!navigator.clipboard) throw new Error('clipboard_unavailable');
            await navigator.clipboard.writeText(code);
            new Notice('Clip2MD: 绑定码已复制。', 3000);
            button.setText('已复制');
            this.plugin.timers.setTimeout(() => button.setText('复制绑定码'), 2000, 'settings-ui');
        } catch {
            new Notice(`Clip2MD 绑定码：${code}`, 6000);
        }
    }

    private async openMiniapp(button: HTMLButtonElement): Promise<void> {
        if (!this.bindingSession || this.launchState === 'loading') return;
        if (this.launchUrl) {
            try {
                window.location.assign(this.launchUrl);
            } catch {
                new Notice('Clip2MD: 请再次点击按钮打开小程序。', 4000);
            }
            return;
        }
        this.launchState = 'loading';
        this.launchMessage = '';
        button.disabled = true;
        button.setText('正在准备小程序…');
        try {
            this.launchUrl = await this.bindingClient.launchLink(this.bindingSession.device_code);
            this.launchState = 'ready';
        } catch (error) {
            this.launchState = 'unavailable';
            this.launchMessage = error instanceof DeviceBindingError && error.code === 'url_link_quota_exhausted'
                ? '今日快捷入口暂不可用，请使用二维码或绑定码。'
                : '快捷入口暂不可用，请使用二维码或绑定码。';
            button.disabled = false;
            button.setText('打开 Clip2MD 小程序');
            this.refresh();
            return;
        }
        button.disabled = false;
        button.setText('打开 Clip2MD 小程序');
        // Navigate immediately while retaining launchUrl for a second,
        // synchronous click if a WebView blocks this first navigation.
        try {
            window.location.assign(this.launchUrl);
        } catch {
            this.launchMessage = '请再次点击按钮打开小程序。';
            this.refresh();
        }
    }

    hide(): void {
        this.releaseActivePage();
    }

    private renderBasicSettings(containerEl: HTMLElement) {
        const account = this.createSettingsSection(containerEl, '账号与设备');

        new Setting(account)
            .setName('重新扫码绑定此设备')
            .setDesc('新绑定完成前保留当前连接')
            .addButton(btn => btn.setButtonText('生成绑定码').onClick(() => {
                this.showBindingForExistingKey = true;
                this.refreshDisplay();
            }));

        for (const taskId of this.plugin.getMigrationUnresolvedTasks()) {
            new Setting(account)
                .setName(`迁移待确认任务 #${taskId}`)
                .setDesc('旧配置指向的笔记在本机不存在。请选择保留忽略或重新导入，选择前不提交该任务的删除回执。')
                .addButton(btn => btn.setButtonText('保留忽略').onClick(() => {
                    this.runAsync(() => this.plugin.resolveMigrationTask(taskId, 'ignore'));
                }))
                .addButton(btn => btn.setButtonText('重新导入').onClick(() => {
                    this.runAsync(() => this.plugin.resolveMigrationTask(taskId, 'reimport'));
                }));
        }

        if (this.plugin.hasLegacySharedState()) {
            new Setting(account)
                .setName('清理旧共享状态')
                .setDesc('确认所有设备均已升级并分别绑定后，清除 Vault 配置中的旧 Key 和进度。旧版插件将无法再从共享配置恢复。')
                .addButton(btn => btn
                    .setButtonText(this.confirmLegacyCleanup ? '再次点击，确认清理' : '清理旧状态')
                    .onClick(() => {
                        if (!this.confirmLegacyCleanup) {
                            this.confirmLegacyCleanup = true;
                            btn.setButtonText('再次点击，确认清理');
                            return;
                        }
                        this.confirmLegacyCleanup = false;
                        this.runAsync(() => this.plugin.clearLegacySharedState());
                    }));
        }

        new Setting(account)
            .setName('API Key')
            .setDesc('使用独立 Key 连接当前设备')
            .addText(text => {
                text.setPlaceholder('clip2md_...')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange((value) => {
                        this.runAsync(async () => {
                            this.plugin.settings.apiKey = value.trim();
                            await this.plugin.saveSettings();
                        });
                    });
                text.inputEl.type = 'password';
            })
            .addExtraButton(btn => btn
                .setIcon('external-link')
                .setTooltip('获取 API Key')
                .onClick(() => this.plugin.openCredentialPage()));

        new Setting(account)
            .setName('连接诊断')
            .setDesc('仅检查账号与 API 连接，不同步内容')
            .addButton(btn => btn.setButtonText('测试连接').onClick(() => {
                this.runAsync(() => this.testConnection(btn.buttonEl));
            }));

        const location = this.createSettingsSection(containerEl, '保存位置', true);

        // 目标文件夹 - 放在保存位置中，与高级设置联动
        const folderSetting = new Setting(location)
            .setName('目标文件夹')
            .setDesc('可使用 {{title}}、{{source_title}} 等变量；留空停止同步')
            .addText(text => text
                .setPlaceholder('留空则不同步')
                .setValue(this.plugin.settings.targetFolder)
                .onChange((value) => {
                    this.runAsync(async () => {
                        const trimmed = value.trim();
                        this.plugin.settings.targetFolder = trimmed;
                        await this.plugin.saveSettings();
                        this.syncFolderInputs(containerEl, trimmed);
                        this.updateFolderReminder(trimmed);
                    });
                }))
            .addExtraButton(btn => btn
                .setIcon('folder')
                .setTooltip('浏览文件夹')
                .onClick(() => {
                    this.openFolderPicker(containerEl);
                }));
        this.folderSettingEl = folderSetting.settingEl;

        // 空文件夹提醒（紧跟在目标文件夹设置项后面）
        if (!this.plugin.settings.targetFolder) {
            this.insertFolderReminder();
        }
    }

    // 同步两个目标文件夹输入框的值
    private syncFolderInputs(containerEl: HTMLElement, value: string) {
        (this.activeContainerEl || containerEl).querySelectorAll<HTMLInputElement>('input[placeholder="留空则不同步"]').forEach(input => {
            if (document.activeElement !== input) {
                input.value = value;
            }
        });
    }

    private openFolderPicker(containerEl: HTMLElement): void {
        const modal = new FolderPickerModal(this.app, this.plugin.settings.targetFolder, (folder) => {
            // 更新所有目标文件夹输入框
            (this.activeContainerEl || containerEl).querySelectorAll<HTMLInputElement>('input[placeholder="留空则不同步"]').forEach(input => {
                input.value = folder;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });
        modal.open();
    }

    private openImageFolderPicker(containerEl: HTMLElement): void {
        const current = this.plugin.settings.imageFolder;
        const modal = new FolderPickerModal(this.app, current === '/' ? '' : current, (folder) => {
            const input = containerEl.querySelector<HTMLInputElement>(`input[placeholder="${IMAGE_FOLDER_PLACEHOLDER}"]`);
            if (input) {
                input.value = folder || '/';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, '选择图片存放目录');
        modal.open();
    }

    private renderAdvancedSettings(containerEl: HTMLElement, hideHeader = false) {
        if (hideHeader) {
            this.renderAdvancedContent(containerEl);
            return;
        }

        this.renderAdvancedContent(containerEl);
    }

    private renderAdvancedContent(containerEl: HTMLElement) {
        const sync = this.createSettingsSection(containerEl, '同步规则');

        new Setting(sync)
            .setName('启动后自动同步')
            .setDesc('启动 Obsidian 后自动同步一次')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnStart)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.syncOnStart = value;
                        await this.plugin.saveSettings();
                    });
                }));

        new Setting(sync)
            .setName('同步间隔')
            .setDesc('后台自动同步频率')
            .addDropdown(dropdown => {
                for (const option of SYNC_INTERVAL_OPTIONS) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown
                    .setValue(String(this.plugin.settings.syncInterval))
                    .onChange((value) => {
                        this.runAsync(async () => {
                            this.plugin.settings.syncInterval = Number(value);
                            await this.plugin.saveSettings();
                        });
                    });
            });

        new Setting(sync)
            .setName('本地删除或改名后不再补回')
            .setDesc('本地删除、改名或移动后，下次同步不再恢复文件；仅对当前 Vault 生效。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.preventReimportAfterLocalRemoval)
                .onChange((value) => {
                    this.runAsync(async () => {
                        await this.plugin.setPreventReimportAfterLocalRemoval(value);
                    });
                }));

        const organization = this.createSettingsSection(containerEl, '命名与目录');
        new Setting(organization)
            .setName('评论存放目录')
            .setDesc('留空跟随主笔记目录；仅影响新建评论笔记。')
            .addText(text => {
                text.setPlaceholder('默认：主笔记目录')
                    .setValue(this.plugin.settings.commentFolder || '')
                    .onChange(value => this.runAsync(async () => {
                        this.plugin.settings.commentFolder = value.trim();
                        await this.plugin.saveSettings();
                    }));
                text.inputEl.dataset.control = 'comment-folder';
            })
            .addExtraButton(button => button.setIcon('folder').setTooltip('选择评论存放目录').onClick(() => {
                new FolderPickerModal(this.app, this.plugin.settings.commentFolder || '', folder => {
                    const input = Array.from(containerEl.querySelectorAll<HTMLInputElement>('[data-control="comment-folder"]')).find(el => el.type !== 'hidden');
                    if (input) { input.value = folder; input.dispatchEvent(new Event('input', { bubbles: true })); }
                }, '选择评论存放目录').open();
            }));

        const titleSetting = new Setting(organization).setName('笔记标题')
            .setDesc('默认跟随网站设置；{{note_title}} 跟随标题选择。');
        const custom = new Setting(organization).setName('自定义标题模板')
            .setDesc('支持 {{title}}、{{source_title}}、{{display_title}}、{{source}}、{{created_date}}、{{task_id}}；空结果使用网站标题。');
        custom.addText(text => text.setValue(this.plugin.settings.customTitleTemplate || '').onChange(value => {
            const error = validateCustomTitle(value);
            custom.setDesc(error ? `未保存：${error}` : '支持标题、来源、日期和任务 ID 变量；空结果使用网站标题。');
            custom.settingEl.toggleClass('clip2md-title-invalid', !!error);
            if (error) return;
            this.plugin.settings.customTitleTemplate = value;
            this.runAsync(async () => { await this.plugin.saveSettings(); this.updatePreview(containerEl); this.noteContent?.refreshPreview(); });
        }));
        custom.settingEl.hidden = this.plugin.settings.titleMode !== 'custom';
        titleSetting.addDropdown(dropdown => dropdown
            .addOption('website', '跟随网站设置').addOption('source', '原标题')
            .addOption('task', 'AI标题').addOption('custom', '自定义标题模板')
            .setValue(this.plugin.settings.titleMode || 'website').onChange(value => {
                this.plugin.settings.titleMode = value as TitleMode;
                custom.settingEl.hidden = value !== 'custom';
                this.runAsync(async () => { await this.plugin.saveSettings(); this.updatePreview(containerEl); this.noteContent?.refreshPreview(); });
            }));

        new Setting(organization)
            .setName('文件夹/文件名预设')
            .setDesc('快速应用推荐的输出组织方式')
            .addDropdown(dropdown => {
                dropdown.addOption('', '选择预设');
                FOLDER_PRESETS.forEach((preset, index) => {
                    dropdown.addOption(String(index), preset.label);
                });
                dropdown.onChange((value) => {
                    this.runAsync(async () => {
                        if (value === '') return;
                        const preset = FOLDER_PRESETS[Number(value)];
                        if (!preset) return;
                        const folderWasEmpty = !this.plugin.settings.targetFolder;
                        // 只保存文件名模板，文件夹由用户确认后保存
                        this.plugin.settings.filenameTemplate = preset.filenameTemplate;
                        await this.plugin.saveSettings();
                        // 更新文件夹输入框的显示值（不保存到设置）
                        (this.activeContainerEl || containerEl).querySelectorAll<HTMLInputElement>('input[placeholder="留空则不同步"]').forEach(input => {
                            input.value = preset.targetFolder;
                        });
                        const filenameInput = containerEl.querySelector<HTMLInputElement>(`input[placeholder="${NEW_DEFAULT_FILENAME_TEMPLATE}"]`);
                        if (filenameInput) filenameInput.value = preset.filenameTemplate;
                        this.updatePreview(containerEl);
                        // 如果文件夹之前为空，滚动到文件夹区域，滚动结束后闪烁提醒
                        if (folderWasEmpty) {
                            this.folderSettingEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            this.insertFolderReminder();
                            this.plugin.timers.setTimeout(() => {
                                this.flashFolderInput(containerEl);
                            }, 500, 'settings-ui');
                        }
                    });
                });
            });

        new Setting(organization)
            .setName('文件名模板')
            .setDesc('默认日期加笔记标题；{{note_title}} 跟随标题选择，其他变量保留各自含义。')
            .addText(text => text
                .setPlaceholder(NEW_DEFAULT_FILENAME_TEMPLATE)
                .setValue(this.plugin.settings.filenameTemplate)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.filenameTemplate = value.trim() || NEW_DEFAULT_FILENAME_TEMPLATE;
                        await this.plugin.saveSettings();
                        this.updatePreview(containerEl);
                    });
                }));

        new Setting(organization)
            .setName('日期格式')
            .setDesc('用于 {{created_date}}，默认 yyyy-MM-dd')
            .addText(text => text
                .setPlaceholder('yyyy-MM-dd')
                .setValue(this.plugin.settings.filenameDateFormat)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.filenameDateFormat = value.trim() || 'yyyy-MM-dd';
                        await this.plugin.saveSettings();
                        this.updatePreview(containerEl);
                    });
                }));

        const preview = this.plugin.getTemplatePreview();
        organization.createDiv({
            cls: 'setting-item-description clip2md-preview-block clip2md-path-preview',
            text: `示例目录：${preview.folder}\n示例文件：${preview.filename}`,
        });
        const content = this.createSettingsSection(containerEl, '笔记内容');
        this.renderNoteContent(content);
        const images = this.createSettingsSection(containerEl, '图片');
        new Setting(images)
            .setName('图片处理')
            .setDesc('将正文图片保存到知识库，或完全不保存图片')
            .addDropdown(dropdown => dropdown
                .addOption('local', '下载到本地')
                .addOption('disabled', '不保存图片')
                .setValue(this.plugin.settings.imageMode)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.imageMode = value === 'disabled' ? 'disabled' : 'local';
                        await this.plugin.saveSettings();
                    });
                }));

        new Setting(images)
            .setName('图片存放目录')
            .setDesc('留空保存到每篇笔记旁的 _assets/task-任务ID')
            .addText(text => text
                .setPlaceholder(IMAGE_FOLDER_PLACEHOLDER)
                .setValue(this.plugin.settings.imageFolder)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.imageFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
                }))
            .addExtraButton(btn => btn
                .setIcon('folder')
                .setTooltip('浏览图片存放目录')
                .onClick(() => this.openImageFolderPicker(images)));
        const maintenance = this.createSettingsSection(containerEl, '维护与帮助');
        this.plugin.renderDiagnostics?.(maintenance);
        this.renderHelpActions(maintenance);
    }

    private createSettingsSection(containerEl: HTMLElement, name: string, defaultOpen = false): HTMLDetailsElement {
        this.settingsSectionsOpen ??= new Set<string>(['同步规则', '保存位置']);
        const details = containerEl.createEl('details', { cls: 'clip2md-settings-section' });
        details.createEl('summary', { text: name });
        details.open = this.settingsSectionsOpen.has(name) || defaultOpen && !Array.from(containerEl.querySelectorAll('details.clip2md-settings-section')).length;
        details.addEventListener('toggle', () => {
            this.advancedOpen = Array.from(containerEl.querySelectorAll('details.clip2md-settings-section'))
                .some(item => (item as HTMLDetailsElement).open);
            if (details.open) this.settingsSectionsOpen.add(name);
            else this.settingsSectionsOpen.delete(name);
        });
        return details;
    }

    private renderNoteContent(containerEl: HTMLElement) {
        this.noteContent?.dispose();
        this.noteContent = new NoteContentSettings(this.plugin, containerEl, this.noteContentState || (this.noteContentState = {}));
    }

    private updatePreview(containerEl: HTMLElement) {
        // 更新预览区域显示
        const previewEl = containerEl.querySelector('.clip2md-path-preview');
        if (previewEl) {
            const preview = this.plugin.getTemplatePreview();
            previewEl.textContent = `示例目录：${preview.folder}\n示例文件：${preview.filename}`;
        }
    }

    private insertFolderReminder() {
        if (!this.folderSettingEl) return;
        // 避免重复插入
        const existing = this.folderSettingEl.parentElement?.querySelector('.clip2md-folder-reminder');
        if (existing) return;
        const parentEl = this.folderSettingEl.parentElement;
        if (!parentEl) return;
        const reminder = parentEl.createDiv({
            cls: 'clip2md-folder-reminder',
            text: '⚠️ 未配置目标文件夹，同步功能不会生效。请设置文件夹路径。',
        });
        this.folderSettingEl.after(reminder);
    }

    private updateFolderReminder(folderValue: string) {
        if (!this.folderSettingEl) return;
        const existing = this.folderSettingEl.parentElement?.querySelector('.clip2md-folder-reminder');
        if (folderValue) {
            existing?.remove();
        } else if (!existing) {
            this.insertFolderReminder();
        }
    }

    private flashFolderInput(containerEl: HTMLElement) {
        // 对整个设置项行做闪烁，确保视觉上可见
        const target = this.folderSettingEl || containerEl.querySelector<HTMLInputElement>('input[placeholder="留空则不同步"]');
        if (!target) return;
        target.classList.remove('clip2md-flash');
        // 强制重排以重新触发动画
        void target.offsetWidth;
        target.classList.add('clip2md-flash');
        target.addEventListener('animationend', () => {
            target.classList.remove('clip2md-flash');
        }, { once: true });
    }

}

export class FolderPickerModal extends Modal {
    private newFolderOpen = false;
    private newFolderName = '';
    private newFolderError = '';
    private creatingFolder = false;
    private closed = false;
    private selectedPath: string = '';
    private filterQuery = '';
    private expandedFolders: Set<string> = new Set();
    private onSelect: (path: string) => void;
    private root: TFolder;

    constructor(app: App, initialPath: string, onSelect: (path: string) => void, private readonly title = '选择目标文件夹') {
        super(app);
        const initial = initialPath && initialPath !== '/' ? app.vault.getAbstractFileByPath(initialPath) : null;
        this.selectedPath = initial instanceof TFolder ? initial.path : '';
        this.onSelect = onSelect;

        // 获取根目录
        this.root = this.app.vault.getRoot();

        // 默认展开根目录和当前选择的路径
        this.expandedFolders.add('');
        if (this.selectedPath) {
            const parts = this.selectedPath.split('/');
            let current = '';
            parts.forEach(part => {
                this.expandedFolders.add(current);
                current = current ? `${current}/${part}` : part;
            });
        }

    }

    onOpen() {
        this.closed = false;
        const { contentEl } = this;
        contentEl.empty();
        installButtonClickGuard(contentEl);

        this.titleEl.setText(this.title);

        // 显示当前选择
        const currentEl = contentEl.createDiv({
            cls: 'clip2md-folder-picker-current',
            attr: { 'aria-live': 'polite' },
        });
        currentEl.createSpan({ text: '当前目录', cls: 'clip2md-folder-picker-current-label' });
        currentEl.createEl('code', { text: this.selectedPath || '(根目录)' });

        const searchWrap = contentEl.createDiv({ cls: 'clip2md-folder-picker-search' });
        const search = searchWrap.createEl('input', {
            attr: {
                type: 'search',
                placeholder: '搜索文件夹…',
                'aria-label': '搜索文件夹',
                'data-control': 'folder-picker-search',
            },
        });
        search.value = this.filterQuery;
        search.disabled = this.creatingFolder;
        search.addEventListener('input', () => {
            this.filterQuery = search.value;
            this.onOpen();
            const again = this.contentEl.querySelector<HTMLInputElement>('[data-control="folder-picker-search"]');
            again?.focus();
            again?.setSelectionRange(again.value.length, again.value.length);
        });
        if (this.filterQuery) {
            const clear = searchWrap.createEl('button', { text: '清除', cls: 'clip2md-folder-picker-search-clear' });
            clear.type = 'button';
            clear.addEventListener('click', () => {
                this.filterQuery = '';
                this.onOpen();
                this.contentEl.querySelector<HTMLInputElement>('[data-control="folder-picker-search"]')?.focus();
            });
        }

        // 文件夹树
        const treeEl = contentEl.createDiv({ cls: 'clip2md-folder-picker-tree' });
        const rendered = this.renderFolderTree(treeEl, this.root, 0, Boolean(this.filterQuery.trim()));
        if (!rendered) {
            const empty = treeEl.createDiv({ cls: 'clip2md-folder-picker-empty', attr: { role: 'status' } });
            empty.createEl('strong', { text: this.filterQuery.trim() ? '没有匹配的文件夹' : '暂无可选文件夹' });
            empty.createEl('p', { text: this.filterQuery.trim() ? '调整搜索词，或在下方新建文件夹。' : '可在下方新建文件夹。' });
        }

        const createArea = contentEl.createDiv({ cls: 'clip2md-folder-picker-create' });
        const openCreate = createArea.createEl('button', { text: '新建文件夹', cls: 'clip2md-folder-picker-new-toggle' });
        openCreate.type = 'button'; openCreate.disabled = this.creatingFolder;
        openCreate.addEventListener('click', () => { this.newFolderOpen = true; this.newFolderError = ''; this.onOpen(); this.contentEl.querySelector<HTMLInputElement>('[data-control="new-folder-name"]')?.focus(); });
        if (this.newFolderOpen) {
            const location = createArea.createEl('p', { cls: 'setting-item-description' });
            location.textContent = `新建位置：${this.selectedPath || '(根目录)'}`;
            const input = createArea.createEl('input', { attr: { type: 'text', placeholder: '文件夹名称', 'aria-label': '新文件夹名称', 'data-control': 'new-folder-name' } });
            input.value = this.newFolderName; input.disabled = this.creatingFolder;
            input.addEventListener('input', () => { this.newFolderName = input.value; });
            input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void this.createFolder(); } });
            const create = createArea.createEl('button', { text: this.creatingFolder ? '创建中…' : '创建', cls: 'mod-cta' });
            create.type = 'button'; create.disabled = this.creatingFolder;
            create.addEventListener('click', () => { void this.createFolder(); });
            const cancel = createArea.createEl('button', { text: '取消新建' });
            cancel.type = 'button'; cancel.disabled = this.creatingFolder;
            cancel.addEventListener('click', () => { this.newFolderOpen = false; this.newFolderName = ''; this.newFolderError = ''; this.onOpen(); });
            if (this.newFolderError) {
                const error = createArea.createEl('p', { cls: 'clip2md-error-text', attr: { role: 'alert' } });
                error.textContent = this.newFolderError;
            }
        }

        // 按钮
        const buttonContainer = contentEl.createDiv({ cls: 'clip2md-folder-picker-buttons' });

        const select = buttonContainer.createEl('button', {
            text: '选择此文件夹',
            cls: 'mod-cta',
        });
        select.disabled = this.creatingFolder;
        select.addEventListener('click', () => {
            this.onSelect(this.selectedPath);
            this.close();
        });

        buttonContainer.createEl('button', {
            text: '取消',
        }).addEventListener('click', () => {
            this.close();
        });
    }

    private async createFolder(): Promise<void> {
        if (this.creatingFolder || this.closed) return;
        const name = this.newFolderName.trim();
        if (!name || name === '.' || name === '..' || /[/\\<>:"|?*]/.test(name) || Array.from(name).some(c => c.charCodeAt(0) < 32)) {
            this.newFolderError = '请输入有效的单个文件夹名称，不能包含 /、\\ 或系统保留字符。'; this.renderCreationError(); return;
        }
        const parent = this.selectedPath;
        const path = parent ? `${parent}/${name}` : name;
        if (this.app.vault.getAbstractFileByPath(path)) { this.newFolderError = '该名称已存在，请使用其他名称。'; this.renderCreationError(); return; }
        if (parent && !(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) { this.newFolderError = '选中目录已不存在，请重新选择。'; this.renderCreationError(); return; }
        this.creatingFolder = true; this.newFolderError = ''; this.onOpen();
        try {
            await this.app.vault.createFolder(path);
            this.selectedPath = path;
            this.expandedFolders.add(this.root.path); this.expandedFolders.add(parent);
            this.newFolderOpen = false; this.newFolderName = '';
        } catch (error) { this.newFolderError = error instanceof Error ? error.message : '创建失败，请重试。'; }
        finally {
            this.creatingFolder = false;
            if (!this.closed) {
                if (this.newFolderError) this.renderCreationError();
                else {
            this.onOpen();
                    Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>('.clip2md-tree-item')).find(button => button.dataset.path === this.selectedPath)?.focus();
                }
            }
        }
    }

    private renderCreationError(): void {
        this.onOpen();
        this.contentEl.querySelector<HTMLInputElement>('[data-control="new-folder-name"]')?.focus();
    }

    private renderFolderTree(containerEl: HTMLElement, folder: TFolder, depth: number, filtering: boolean): boolean {
        const isRoot = depth === 0;
        const path = isRoot ? '' : folder.path;
        const isExpanded = this.expandedFolders.has(path);
        const isSelected = this.selectedPath === path;
        const query = this.filterQuery.trim().toLocaleLowerCase();
        const matches = !query || (!isRoot && (path.toLocaleLowerCase().includes(query) || folder.name.toLocaleLowerCase().includes(query)));
        const children = folder.children.filter((child): child is TFolder => child instanceof TFolder).sort((a, b) => a.name.localeCompare(b.name));
        const renderedChildren: HTMLElement[] = [];
        for (const child of children) {
            const childWrap = containerEl.createDiv();
            if (this.renderFolderTree(childWrap, child, depth + 1, filtering)) renderedChildren.push(childWrap);
        }
        const shouldRender = matches || renderedChildren.length > 0;
        if (!shouldRender) return false;

        const hasSubfolders = children.length > 0;
        const itemEl = containerEl.createEl('button', {
            cls: `clip2md-tree-item ${isSelected ? 'selected' : ''}`,
        });
        containerEl.insertBefore(itemEl, containerEl.firstChild);
        itemEl.type = 'button';
        itemEl.dataset.path = path;
        itemEl.setAttribute('aria-pressed', String(isSelected));
        if (hasSubfolders) itemEl.setAttribute('aria-expanded', String(filtering || isExpanded));
        itemEl.disabled = this.creatingFolder;
        itemEl.setCssProps({ '--clip2md-tree-item-padding-left': `${depth * 16 + 8}px` });

        itemEl.createSpan({
            text: hasSubfolders ? (filtering || isExpanded ? '▼' : '▶') : ' ',
            cls: 'clip2md-tree-toggle',
        });
        itemEl.createSpan({ text: '📁', cls: 'clip2md-tree-icon' });
        itemEl.createSpan({ text: isRoot ? '(根目录)' : folder.name, cls: 'clip2md-tree-name' });

        itemEl.addEventListener('click', () => {
            this.selectedPath = path;
            if (hasSubfolders && !filtering) {
                if (isExpanded) this.expandedFolders.delete(path);
                else this.expandedFolders.add(path);
            }
            this.onOpen();
            Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>('.clip2md-tree-item'))
                .find(button => button.dataset.path === path)?.focus();
        });

        if (!filtering && hasSubfolders && !isExpanded) renderedChildren.forEach(element => element.remove());
        return true;
    }

    onClose() {
        this.closed = true;
        this.contentEl.empty();
    }
}
