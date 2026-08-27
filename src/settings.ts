import { App, FuzzySuggestModal, Modal, Notice, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, TextAreaComponent } from 'obsidian';
import type BijiSyncPlugin from './main';
import { DeviceBindingClient, DeviceBindingError, DeviceBindingSession } from './binding';

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
    failed: number;
    errorMessage?: string;
}

export interface BijiSyncSettings {
    apiKey: string;
    credentialId?: number;
    credentialName?: string;
    installationId: string;
    settingsSchemaVersion: number;
    syncInterval: number;
    syncOnStart: boolean;
    targetFolder: string;
    filenameTemplate: string;
    filenameDateFormat: string;
    template: string;
    frontmatterTemplate: string;
    syncContentMode: SyncContentMode;
    imageMode: ImageMode;
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

const TEMPLATE_PRESETS: Array<{ value: SyncContentMode; label: string; template: string }> = [
    { value: 'full', label: '完整内容', template: '{{content}}' },
    { value: 'note', label: '仅智能笔记', template: '{{note_content}}' },
    { value: 'source', label: '仅原文', template: '{{source_content}}' },
];

const FOLDER_PRESETS = [
    { label: '全部放在一个目录', targetFolder: 'Clip2MD', filenameTemplate: '{{created_date}}-{{title}}' },
    { label: '按日期', targetFolder: 'Clip2MD/{{created_date}}', filenameTemplate: '{{title}}' },
    { label: '按来源/日期', targetFolder: 'Clip2MD/{{source}}/{{created_date}}', filenameTemplate: '{{title}}' },
];

export const DEFAULT_FRONTMATTER_TEMPLATE = `---
title: "{{title}}"
date: "{{source_date}}"
source: "{{source}}"
tags: {{tags}}
task_id: {{task_id}}
---`;

// Used only to upgrade installations that still have the v1.0.3 built-in
// template saved in their data.json. Custom templates are left untouched.
export const LEGACY_DEFAULT_FRONTMATTER_TEMPLATE = `---
title: "{{title}}"
date: "{{source_date}}"
source: "{{source}}"
task_id: {{task_id}}
---`;

const INSERTABLE_TEMPLATE_VARIABLES = [
    '{{content}}',
    '{{note_content}}',
    '{{source_content}}',
    '{{title}}',
    '{{source}}',
    '{{date}}',
    '{{created_at}}',
    '{{created_date}}',
    '{{duration}}',
    '{{content_type}}',
    '{{url}}',
    '{{task_id}}',
    '{{tags}}',
];

export class BijiSyncSettingTab extends PluginSettingTab {
    plugin: BijiSyncPlugin;
    private onboardingDraft: OnboardingDraft | null = null;
    private templatePreviewEl: HTMLElement | null = null;
    private fmPreviewEl: HTMLElement | null = null;
    private folderSettingEl: HTMLElement | null = null;
    private bindingMode: 'qr' | 'manual' = 'qr';
    private bindingClient = new DeviceBindingClient();
    private bindingSession: DeviceBindingSession | null = null;
    private bindingQrDataUrl = '';
    private bindingState: 'idle' | 'starting' | 'waiting' | 'approving' | 'error' | 'expired' = 'idle';
    private bindingMessage = '';
    private bindingTimer: number | null = null;
    private bindingExpiresAt = 0;

    constructor(app: App, plugin: BijiSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async testConnection(btnEl: HTMLElement): Promise<void> {
        const origText = btnEl.textContent;
        btnEl.textContent = '测试中...';
        btnEl.toggleClass('is-loading', true);

        const { apiKey } = this.plugin.settings;
        if (!apiKey) {
            new Notice('Clip2MD: 请先填写 API Key');
            btnEl.textContent = origText;
            btnEl.toggleClass('is-loading', false);
            return;
        }

        try {
            await this.plugin.verifyConnection();
            new Notice('Clip2MD: 连接成功，可以开始同步。', 5000);
            this.display();
        } catch (err) {
            this.plugin.handleConnectionError(err);
            this.display();
        } finally {
            btnEl.textContent = origText;
            btnEl.toggleClass('is-loading', false);
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // 重置预览元素引用（DOM 已被清空）
        this.templatePreviewEl = null;
        this.fmPreviewEl = null;
        this.folderSettingEl = null;

        containerEl.createEl('p', {
            text: 'Clip2MD 会自动将网页剪藏同步到 Obsidian。同一任务会更新同一个文件，不会覆盖你手动创建的笔记。',
            cls: 'setting-item-description',
        });

        this.renderStatusBar(containerEl);

        if (!this.plugin.settings.apiKey) {
            this.renderOnboarding(containerEl);
            return;
        }

        this.renderBasicSettings(containerEl);
        this.renderAdvancedSettings(containerEl);
    }
    private renderStatusBar(containerEl: HTMLElement) {
        const status = this.plugin.getStatusSnapshot();
        const wrap = containerEl.createDiv({ cls: 'clip2md-status-bar' });
        wrap.createDiv({
            cls: `clip2md-status-indicator is-${status.kind}`,
            text: status.label,
        });

        wrap.createDiv({
            cls: 'clip2md-status-summary',
            text: status.description,
        });

        const actions = wrap.createDiv({ cls: 'clip2md-status-actions' });
        const syncButton = actions.createEl('button', {
            text: status.runtimeState === 'syncing' ? '同步中...' : '立即同步',
            cls: 'mod-cta',
        });
        syncButton.toggleClass('clip2md-inline-button', true);
        syncButton.disabled = status.runtimeState === 'syncing';
        syncButton.addEventListener('click', async () => {
            await this.plugin.syncNow('manual');
            this.display();
        });

        const testButton = actions.createEl('button', {
            text: '测试连接',
            cls: 'clip2md-inline-button',
        });
        testButton.disabled = !this.plugin.settings.apiKey || status.runtimeState === 'syncing';
        testButton.addEventListener('click', async () => {
            await this.testConnection(testButton);
        });
    }

    private renderOnboarding(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: '欢迎使用 Clip2MD' });
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
            this.display();
        });
        manualTab.addEventListener('click', () => {
            this.bindingMode = 'manual';
            this.stopBindingPolling();
            this.display();
        });
        if (this.bindingMode === 'qr') {
            this.renderQrOnboarding(containerEl);
        } else {
            this.renderManualOnboarding(containerEl);
        }
        const advanced = containerEl.createEl('details');
        advanced.createEl('summary', { text: '使用高级设置' });
        this.renderAdvancedSettings(advanced, true);
    }

    private renderQrOnboarding(containerEl: HTMLElement): void {
        const card = containerEl.createDiv({ cls: 'clip2md-guide-card clip2md-binding-card' });
        card.createEl('div', { text: '打开微信扫一扫，确认后自动完成绑定', cls: 'clip2md-binding-title' });
        if (this.bindingQrDataUrl) {
            card.createEl('img', {
                attr: { src: this.bindingQrDataUrl, alt: 'Clip2MD 小程序码' },
                cls: 'clip2md-binding-qrcode',
            });
        } else {
            card.createDiv({
                text: this.bindingState === 'error' ? '小程序码加载失败' : '正在生成小程序码…',
                cls: 'clip2md-binding-placeholder',
            });
        }
        if (this.bindingSession) {
            card.createEl('code', { text: this.bindingSession.user_code, cls: 'clip2md-binding-code' });
        }
        card.createEl('p', {
            text: this.bindingMessage || '小程序码 10 分钟内有效，请在手机端确认本次绑定。',
            cls: this.bindingState === 'error' ? 'clip2md-error-text' : 'setting-item-description',
        });
        if (this.bindingState === 'error' || this.bindingState === 'expired') {
            const retry = card.createEl('button', { text: '重新生成', cls: 'mod-cta' });
            retry.addEventListener('click', () => {
                this.resetBindingSession();
                this.display();
            });
        }
        if (!this.bindingSession && this.bindingState !== 'starting') {
            void this.startBinding();
        }
    }

    private renderManualOnboarding(containerEl: HTMLElement): void {
        if (!this.onboardingDraft) {
            this.onboardingDraft = { apiKey: '', targetFolder: 'Clip2MD' };
        }
        const card = containerEl.createDiv({ cls: 'clip2md-guide-card' });
        new Setting(card)
            .setName('API Key')
            .setDesc('从 Clip2MD API凭证管理页复制完整 Key')
            .addText(text => {
                text.setPlaceholder('clip2md_...')
                    .setValue(this.onboardingDraft?.apiKey ?? '')
                    .onChange(value => {
                        if (this.onboardingDraft) this.onboardingDraft.apiKey = value.trim();
                    });
                text.inputEl.type = 'password';
            })
            .addExtraButton(btn => btn.setIcon('external-link').setTooltip('管理 API凭证').onClick(() => this.plugin.openCredentialPage()));
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
            .addButton(btn => btn.setButtonText('保存并连接').setCta().onClick(async () => {
                const draft = this.onboardingDraft ?? { apiKey: '', targetFolder: 'Clip2MD' };
                if (!draft.apiKey || !this.plugin.validateTargetFolder(draft.targetFolder)) {
                    new Notice('Clip2MD: 请填写有效的 API Key 和目标文件夹。', 5000);
                    return;
                }
                btn.setDisabled(true);
                try {
                    await this.plugin.applyOnboardingSettings(draft);
                    this.onboardingDraft = null;
                    this.display();
                } finally {
                    btn.setDisabled(false);
                }
            }));
    }

    private async startBinding(): Promise<void> {
        this.bindingState = 'starting';
        this.bindingMessage = '正在创建安全绑定请求…';
        try {
            const session = await this.bindingClient.start(this.plugin.getBindingClientName());
            this.bindingSession = session;
            this.bindingExpiresAt = Date.now() + session.expires_in * 1000;
            this.bindingState = 'waiting';
            this.bindingMessage = '请使用微信扫码，并在小程序中确认绑定。';
            this.display();
            try {
                this.bindingQrDataUrl = await this.bindingClient.qrcode(session.device_code);
            } catch (error) {
                this.bindingState = 'error';
                this.bindingMessage = error instanceof Error ? error.message : '小程序码加载失败，请重试。';
                this.display();
                return;
            }
            this.display();
            this.scheduleBindingPoll(session.interval);
        } catch (error) {
            this.bindingState = 'error';
            this.bindingMessage = error instanceof Error ? error.message : '无法创建绑定请求。';
            this.display();
        }
    }

    private scheduleBindingPoll(seconds: number): void {
        this.stopBindingPolling();
        if (!this.bindingSession || this.bindingMode !== 'qr') return;
        this.bindingTimer = window.setTimeout(() => void this.pollBinding(), Math.max(1, seconds) * 1000);
    }

    private async pollBinding(): Promise<void> {
        const session = this.bindingSession;
        if (!session || this.bindingMode !== 'qr') return;
        if (Date.now() >= this.bindingExpiresAt) {
            this.bindingState = 'expired';
            this.bindingMessage = '小程序码已过期，请重新生成。';
            this.display();
            return;
        }
        try {
            const result = await this.bindingClient.credential(session.device_code);
            if (result.status === 'approved') {
                this.stopBindingPolling();
                await this.plugin.applyDeviceCredential(result);
                this.resetBindingSession();
                this.display();
                return;
            }
            this.bindingState = result.status === 'approving' ? 'approving' : 'waiting';
            this.bindingMessage = result.status === 'approving' ? '手机端已确认，正在安全下发 API Key…' : '等待手机端确认…';
            this.display();
            this.scheduleBindingPoll(result.retry_after || session.interval);
        } catch (error) {
            if (error instanceof DeviceBindingError && ['access_denied', 'expired_token'].includes(error.code)) {
                this.bindingState = 'expired';
                this.bindingMessage = error.code === 'access_denied' ? '本次绑定已被拒绝。' : '绑定请求已过期。';
                this.display();
                return;
            }
            const retryAfter = error instanceof DeviceBindingError && error.code === 'slow_down'
                ? Math.min(60, session.interval + 5) : 10;
            this.bindingMessage = '网络暂时不可用，正在重试…';
            this.display();
            this.scheduleBindingPoll(retryAfter);
        }
    }

    private stopBindingPolling(): void {
        if (this.bindingTimer !== null) {
            window.clearTimeout(this.bindingTimer);
            this.bindingTimer = null;
        }
    }

    private resetBindingSession(): void {
        this.stopBindingPolling();
        this.bindingSession = null;
        this.bindingQrDataUrl = '';
        this.bindingState = 'idle';
        this.bindingMessage = '';
        this.bindingExpiresAt = 0;
    }

    hide(): void {
        this.stopBindingPolling();
    }

    private renderBasicSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: '基本设置' });

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('从 clip2md 网站获取的 API Key')
            .addText(text => text
                .setPlaceholder('clip2md_...')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value.trim();
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(btn => btn
                .setIcon('external-link')
                .setTooltip('获取 API Key')
                .onClick(() => this.plugin.openCredentialPage()));

        // 目标文件夹 - 放在基本设置中，与高级设置联动
        const folderSetting = new Setting(containerEl)
            .setName('目标文件夹')
            .setDesc('剪藏文件保存的 Obsidian 文件夹路径，可使用变量。留空则不进行同步。')
            .addText(text => text
                .setPlaceholder('留空则不同步')
                .setValue(this.plugin.settings.targetFolder)
                .onChange(async (value) => {
                    const trimmed = value.trim();
                    this.plugin.settings.targetFolder = trimmed;
                    await this.plugin.saveSettings();
                    this.syncFolderInputs(containerEl, trimmed);
                    this.updateFolderReminder(trimmed);
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
        containerEl.querySelectorAll<HTMLInputElement>('input[placeholder="留空则不同步"]').forEach(input => {
            if (document.activeElement !== input) {
                input.value = value;
            }
        });
    }

    private openFolderPicker(containerEl: HTMLElement): void {
        const modal = new FolderPickerModal(this.app, this.plugin.settings.targetFolder, (folder) => {
            // 更新所有目标文件夹输入框
            containerEl.querySelectorAll<HTMLInputElement>('input[placeholder="留空则不同步"]').forEach(input => {
                input.value = folder;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });
        modal.open();
    }

    private renderAdvancedSettings(containerEl: HTMLElement, hideHeader = false) {
        // 使用 <details> 实现可折叠的高级设置
        if (hideHeader) {
            // 在 onboarding 中被调用，直接渲染内容
            this.renderAdvancedContent(containerEl);
            return;
        }

        const details = containerEl.createEl('details', { cls: 'clip2md-advanced-settings' });
        details.createEl('summary', { text: '高级设置（点击展开）', cls: 'clip2md-advanced-summary' });
        this.renderAdvancedContent(details);
    }

    private renderAdvancedContent(containerEl: HTMLElement) {

        new Setting(containerEl)
            .setName('启动后自动同步')
            .setDesc('Obsidian 完成加载 3 秒后自动执行一次同步')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnStart)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnStart = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('同步间隔')
            .setDesc('自动同步的时间间隔，最低 5 分钟')
            .addDropdown(dropdown => {
                for (const option of SYNC_INTERVAL_OPTIONS) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown
                    .setValue(String(this.plugin.settings.syncInterval))
                    .onChange(async (value) => {
                        this.plugin.settings.syncInterval = Number(value);
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('同步内容预设')
            .setDesc('快速切换同步内容模式')
            .addDropdown(dropdown => {
                for (const option of TEMPLATE_PRESETS) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown
                    .setValue(this.plugin.settings.syncContentMode)
                    .onChange(async (value) => {
                        const preset = TEMPLATE_PRESETS.find(item => item.value === value);
                        this.plugin.settings.syncContentMode = value as SyncContentMode;
                        if (preset) {
                            this.plugin.settings.template = preset.template;
                        }
                        await this.plugin.saveSettings();
                        this.updateTemplatePreviewOnly(containerEl);
                    });
            });

        new Setting(containerEl)
            .setName('文件夹/文件名预设')
            .setDesc('快速应用推荐的输出组织方式')
            .addDropdown(dropdown => {
                dropdown.addOption('', '选择预设');
                FOLDER_PRESETS.forEach((preset, index) => dropdown.addOption(String(index), preset.label));
                dropdown.onChange(async (value) => {
                    if (value === '') return;
                    const preset = FOLDER_PRESETS[Number(value)];
                    if (!preset) return;
                    const folderWasEmpty = !this.plugin.settings.targetFolder;
                    // 只保存文件名模板，文件夹由用户确认后保存
                    this.plugin.settings.filenameTemplate = preset.filenameTemplate;
                    await this.plugin.saveSettings();
                    // 更新文件夹输入框的显示值（不保存到设置）
                    containerEl.querySelectorAll<HTMLInputElement>('input[placeholder="留空则不同步"]').forEach(input => {
                        input.value = preset.targetFolder;
                    });
                    const filenameInput = containerEl.querySelector<HTMLInputElement>('input[placeholder="{{created_date}}-{{title}}"]');
                    if (filenameInput) filenameInput.value = preset.filenameTemplate;
                    this.updatePreview(containerEl);
                    // 如果文件夹之前为空，滚动到文件夹区域，滚动结束后闪烁提醒
                    if (folderWasEmpty) {
                        this.folderSettingEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        this.insertFolderReminder();
                        setTimeout(() => {
                            this.flashFolderInput(containerEl);
                        }, 500);
                    }
                });
            });

        new Setting(containerEl)
            .setName('文件名模板')
            .setDesc('默认 {{created_date}}-{{title}}')
            .addText(text => text
                .setPlaceholder('{{created_date}}-{{title}}')
                .setValue(this.plugin.settings.filenameTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.filenameTemplate = value.trim() || '{{created_date}}-{{title}}';
                    await this.plugin.saveSettings();
                    this.updatePreview(containerEl);
                }));

        new Setting(containerEl)
            .setName('日期格式')
            .setDesc('用于 {{created_date}}，默认 yyyy-MM-dd')
            .addText(text => text
                .setPlaceholder('yyyy-MM-dd')
                .setValue(this.plugin.settings.filenameDateFormat)
                .onChange(async (value) => {
                    this.plugin.settings.filenameDateFormat = value.trim() || 'yyyy-MM-dd';
                    await this.plugin.saveSettings();
                    this.updatePreview(containerEl);
                }));

        const preview = this.plugin.getTemplatePreview();
        containerEl.createEl('div', {
            cls: 'setting-item-description clip2md-preview-block',
            text: `示例目录：${preview.folder}\n示例文件：${preview.filename}`,
        });

        // 前置元数据模板 - 放在 Markdown 模板前面
        this.renderFrontmatterSection(containerEl);

        // Markdown 模板
        this.renderMarkdownTemplateSection(containerEl);

        new Setting(containerEl)
            .setName('图片处理')
            .setDesc('下载图片到本地，或完全不保存图片')
            .addDropdown(dropdown => dropdown
                .addOption('local', '下载到本地')
                .addOption('disabled', '不保存图片')
                .setValue(this.plugin.settings.imageMode)
                .onChange(async (value) => {
                    this.plugin.settings.imageMode = value as ImageMode;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('消息按日合并')
            .setDesc('微信、QQ、邮件可按日期合并到同一文件')
            .addDropdown(dropdown => dropdown
                .addOption('none', '关闭')
                .addOption('daily', '按日合并')
                .setValue(this.plugin.settings.mergeMode)
                .onChange(async (value) => {
                    this.plugin.settings.mergeMode = value as MergeMode;
                    await this.plugin.saveSettings();
                }));

    }

    private renderFrontmatterSection(containerEl: HTMLElement) {
        const FM_VARIABLES = [
            '{{title}}', '{{source_date}}', '{{created_at}}',
            '{{source}}', '{{duration}}', '{{content_type}}',
            '{{task_id}}', '{{tags}}', '{{url}}',
        ];

        const fmSetting = new Setting(containerEl)
            .setName('前置元数据模板')
            .setDesc('每个同步文件的 frontmatter 头部，支持变量。')
            .addTextArea(text => {
                text.setPlaceholder('')
                    .setValue(this.plugin.settings.frontmatterTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.frontmatterTemplate = value;
                        await this.plugin.saveSettings();
                        this.debouncedUpdateFmPreview(containerEl);
                    });
                text.inputEl.rows = 6;
                text.inputEl.addClass('clip2md-template-editor');
            });

        // 变量工具栏
        const toolbarWrap = containerEl.createDiv({ cls: 'clip2md-template-toolbar' });
        toolbarWrap.createSpan({ text: '可用变量：', cls: 'clip2md-toolbar-label' });
        FM_VARIABLES.forEach(variable => {
            const button = toolbarWrap.createEl('button', { text: variable, cls: 'clip2md-chip-button' });
            button.addEventListener('click', () => {
                const textarea = fmSetting.controlEl.querySelector('textarea');
                if (!textarea) return;
                const start = textarea.selectionStart ?? textarea.value.length;
                const end = textarea.selectionEnd ?? textarea.value.length;
                const nextValue = `${textarea.value.slice(0, start)}${variable}${textarea.value.slice(end)}`;
                textarea.value = nextValue;
                textarea.focus();
                textarea.selectionStart = textarea.selectionEnd = start + variable.length;
                this.plugin.settings.frontmatterTemplate = nextValue;
                this.plugin.saveSettings();
                this.debouncedUpdateFmPreview(containerEl);
            });
        });

        const resetButton = toolbarWrap.createEl('button', { text: '恢复默认', cls: 'clip2md-chip-button' });
        resetButton.addEventListener('click', async () => {
            this.plugin.settings.frontmatterTemplate = DEFAULT_FRONTMATTER_TEMPLATE;
            const textarea = fmSetting.controlEl.querySelector('textarea') as HTMLTextAreaElement | null;
            if (textarea) {
                textarea.value = DEFAULT_FRONTMATTER_TEMPLATE;
            }
            await this.plugin.saveSettings();
            this.updateFmPreview();
        });

        // 预览容器
        this.fmPreviewEl = containerEl.createDiv({ cls: 'clip2md-fm-preview-container' });
        this.updateFmPreview();
    }

    private renderMarkdownTemplateSection(containerEl: HTMLElement) {
        const templateSetting = new Setting(containerEl)
            .setName('Markdown 模板')
            .setDesc('支持内容变量、frontmatter 与任务标记')
            .addTextArea(text => {
                text.setPlaceholder('{{content}}')
                    .setValue(this.plugin.settings.template)
                    .onChange(async (value) => {
                        this.plugin.settings.template = value;
                        await this.plugin.saveSettings();
                        this.debouncedUpdateTemplatePreview(containerEl);
                    });
                text.inputEl.rows = 10;
                text.inputEl.addClass('clip2md-template-editor');
            });

        const templateEditor = templateSetting.controlEl.querySelector('textarea') as HTMLTextAreaElement | null;
        if (templateEditor) {
            this.renderTemplateToolbar(containerEl, templateEditor);
            this.renderTemplatePreview(containerEl);
        }
    }

    // 防抖定时器
    private fmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private templateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    private debouncedUpdateFmPreview(_containerEl: HTMLElement) {
        if (this.fmDebounceTimer) clearTimeout(this.fmDebounceTimer);
        this.fmDebounceTimer = setTimeout(() => this.updateFmPreview(), 400);
    }

    private debouncedUpdateTemplatePreview(containerEl: HTMLElement) {
        if (this.templateDebounceTimer) clearTimeout(this.templateDebounceTimer);
        this.templateDebounceTimer = setTimeout(() => this.updateTemplatePreviewOnly(containerEl), 400);
    }

    private updateFmPreview() {
        if (!this.fmPreviewEl) return;
        this.fmPreviewEl.empty();

        const template = this.plugin.settings.frontmatterTemplate;
        if (!template || !template.trim()) {
            return;
        }

        const sample: Record<string, string> = {
            '{{title}}': '示例标题',
            '{{source_date}}': '2026-08-08',
            '{{created_at}}': '2026-08-08T09:30:00Z',
            '{{source}}': '微信公众号',
            '{{duration}}': '5m',
            '{{content_type}}': 'LINK',
            '{{task_id}}': '12345',
            '{{tags}}': '示例, 知识管理',
            '{{url}}': 'https://example.com/article',
        };

        let rendered = template;
        for (const [key, value] of Object.entries(sample)) {
            rendered = rendered.split(key).join(value);
        }

        const previewEl = this.fmPreviewEl.createDiv({
            cls: 'clip2md-preview-block clip2md-fm-preview',
        });
        previewEl.style.margin = '0';
        previewEl.style.whiteSpace = 'pre-wrap';
        previewEl.setText(rendered);
    }

    private updatePreview(containerEl: HTMLElement) {
        // 更新预览区域显示
        const previewEl = containerEl.querySelector('.clip2md-preview-block');
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
        const reminder = document.createElement('div');
        reminder.className = 'clip2md-folder-reminder';
        reminder.textContent = '⚠️ 未配置目标文件夹，同步功能不会生效。请设置文件夹路径。';
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

    private updateTemplatePreviewOnly(_containerEl: HTMLElement) {
        const validation = this.plugin.validateTemplate(this.plugin.settings.template);
        const previewContent = this.plugin.renderTemplatePreview();

        if (!this.templatePreviewEl) return;

        // 清空并重新填充预览区域
        this.templatePreviewEl.empty();

        if (!validation.valid) {
            const errorEl = this.templatePreviewEl.createDiv({
                cls: 'clip2md-preview-block clip2md-template-error clip2md-error-text',
                text: validation.message,
            });
            // 保持样式一致
            errorEl.style.margin = '0';
        }

        const previewEl = this.templatePreviewEl.createDiv({
            cls: 'clip2md-preview-block clip2md-template-preview',
            text: previewContent,
        });
        previewEl.style.margin = '0';
    }

    private renderTemplateToolbar(containerEl: HTMLElement, editor: HTMLTextAreaElement) {
        const buttonWrap = containerEl.createDiv({ cls: 'clip2md-template-toolbar' });
        INSERTABLE_TEMPLATE_VARIABLES.forEach((variable) => {
            const button = buttonWrap.createEl('button', { text: variable, cls: 'clip2md-chip-button' });
            button.addEventListener('click', async () => {
                const start = editor.selectionStart ?? editor.value.length;
                const end = editor.selectionEnd ?? editor.value.length;
                const nextValue = `${editor.value.slice(0, start)}${variable}${editor.value.slice(end)}`;
                editor.value = nextValue;
                editor.focus();
                editor.selectionStart = editor.selectionEnd = start + variable.length;
                this.plugin.settings.template = nextValue;
                await this.plugin.saveSettings();
                this.updateTemplatePreviewOnly(containerEl);
            });
        });

        const resetButton = buttonWrap.createEl('button', { text: '恢复默认', cls: 'clip2md-chip-button' });
        resetButton.addEventListener('click', async () => {
            this.plugin.settings.template = '{{content}}';
            editor.value = '{{content}}';
            editor.focus();
            await this.plugin.saveSettings();
            this.updateTemplatePreviewOnly(containerEl);
        });
    }

    private renderTemplatePreview(containerEl: HTMLElement) {
        // 创建固定的预览容器（只创建一次）
        this.templatePreviewEl = containerEl.createDiv({ cls: 'clip2md-template-preview-container' });

        const validation = this.plugin.validateTemplate(this.plugin.settings.template);
        if (!validation.valid) {
            this.templatePreviewEl.createDiv({
                cls: 'clip2md-preview-block clip2md-template-error clip2md-error-text',
                text: validation.message,
            });
        }

        this.templatePreviewEl.createDiv({
            cls: 'clip2md-preview-block clip2md-template-preview',
            text: this.plugin.renderTemplatePreview(),
        });
    }

}

class FolderPickerModal extends Modal {
    private selectedPath: string = '';
    private expandedFolders: Set<string> = new Set();
    private onSelect: (path: string) => void;
    private root: TFolder;

    constructor(app: App, initialPath: string, onSelect: (path: string) => void) {
        super(app);
        this.selectedPath = initialPath || '';
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

        console.log('[FolderPicker] Root:', this.root.name, 'path:', this.root.path);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        this.titleEl.setText('选择目标文件夹');

        // 显示当前选择
        const currentEl = contentEl.createDiv({
            cls: 'clip2md-folder-picker-current',
        });
        currentEl.createSpan({ text: '当前选择：' });
        currentEl.createEl('code', { text: this.selectedPath || '(根目录)' });

        // 文件夹树
        const treeEl = contentEl.createDiv({ cls: 'clip2md-folder-picker-tree' });
        this.renderFolderTree(treeEl, this.root, 0);

        // 按钮
        const buttonContainer = contentEl.createDiv({ cls: 'clip2md-folder-picker-buttons' });

        buttonContainer.createEl('button', {
            text: '选择此文件夹',
            cls: 'mod-cta',
        }).addEventListener('click', () => {
            this.onSelect(this.selectedPath);
            this.close();
        });

        buttonContainer.createEl('button', {
            text: '取消',
        }).addEventListener('click', () => {
            this.close();
        });
    }

    private renderFolderTree(containerEl: HTMLElement, folder: TFolder, depth: number) {
        const isRoot = depth === 0;
        const isExpanded = this.expandedFolders.has(folder.path);
        const isSelected = this.selectedPath === folder.path;

        // 渲染当前文件夹
        const itemEl = containerEl.createDiv({
            cls: `clip2md-tree-item ${isSelected ? 'selected' : ''}`,
        });
        itemEl.style.paddingLeft = `${depth * 16 + 8}px`;

        // 展开/折叠图标
        const hasSubfolders = folder.children.some(child => child instanceof TFolder);
        itemEl.createSpan({
            text: hasSubfolders ? (isExpanded ? '▼' : '▶') : ' ',
            cls: 'clip2md-tree-toggle',
        });

        // 文件夹图标
        itemEl.createSpan({ text: '📁', cls: 'clip2md-tree-icon' });

        // 文件夹名称
        const name = isRoot ? '(根目录)' : folder.name;
        itemEl.createSpan({ text: name });

        // 点击事件
        itemEl.addEventListener('click', () => {
            if (hasSubfolders) {
                // 切换展开/折叠
                if (isExpanded) {
                    this.expandedFolders.delete(folder.path);
                } else {
                    this.expandedFolders.add(folder.path);
                }
            } else {
                // 没有子文件夹，直接选择
                this.selectedPath = folder.path;
            }
            this.onOpen();
        });

        // 递归渲染子文件夹
        if (hasSubfolders && isExpanded) {
            const subfolders = folder.children
                .filter(child => child instanceof TFolder)
                .sort((a, b) => (a as TFolder).name.localeCompare((b as TFolder).name));

            subfolders.forEach(subfolder => {
                this.renderFolderTree(containerEl, subfolder as TFolder, depth + 1);
            });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
