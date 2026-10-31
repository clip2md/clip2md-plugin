import { Modal, Notice, Platform, Setting, SettingPage } from 'obsidian';
import type BijiSyncPlugin from './main';
import { renderDependency } from './plugin-dependency';
import { BUILD_CHANNEL } from './build-channel';
import { desktopTokens, removeDesktopTokens } from './desktop-variables';
export const DESKTOP_ENABLED_KEY = 'clip2md-desktop-enabled-v1';
const TEMPLATE_KEYS = ['template', 'frontmatterTemplate', 'dailyMergeFrontmatterTemplate', 'customTitleTemplate', 'filenameTemplate', 'targetFolder'] as const;
export async function setDesktopEnabled(plugin: BijiSyncPlugin, enabled: boolean): Promise<boolean> {
    if (!Platform.isDesktopApp || !plugin.companion)
        return false;
    if (enabled) {
        if (!(await plugin.ensureDesktopRuntime()))
            return false;
        await plugin.enableSourcePropertiesTemplate();
        await plugin.companion.snapshot()?.setEnabled?.(true);
        plugin.app.saveLocalStorage(DESKTOP_ENABLED_KEY, true);
        return true;
    }
    return new Promise<boolean>(resolve => {
        const modal = new Modal(plugin.app);
        let confirmed = false;
        modal.titleEl.setText('关闭本地剪藏扩展');
        modal.contentEl.createEl('p', { text: '关闭本地剪藏扩展将停止本地任务，并清除主插件模板中的桌面相关变量。其他配置、原站授权、历史笔记和已下载素材将保留。' });
        const affected = TEMPLATE_KEYS.flatMap(key => desktopTokens(plugin.settings[key] || '').map(name => `${key}: {{${name}}}`));
        modal.contentEl.createEl('pre', { text: affected.join('\n') || '当前模板没有桌面变量。' });
        modal.onClose = () => {
            if (!confirmed)
                resolve(false);
        };
        new Setting(modal.contentEl).addButton(b => b.setButtonText('取消').onClick(() => modal.close()))
            .addButton(b => b.setButtonText('关闭并清理模板字段').setDestructive().onClick(() => {
            void (async () => {
                const beforeInitialized=plugin.settings.sourcePropertiesTemplateInitialized;
                const before = Object.fromEntries(TEMPLATE_KEYS.map(key => [key, plugin.settings[key]]));
                const cleaned = Object.fromEntries(TEMPLATE_KEYS.map(key => [key, removeDesktopTokens(plugin.settings[key] || '', key.includes('rontmatter'))]));
                const backup = `${plugin.app.vault.configDir}/clip2md/settings/desktop-template-backup-${Date.now()}.json`;
                await plugin.app.vault.adapter.write(backup, JSON.stringify(before));
                if (!String(cleaned.template).trim())
                    cleaned.template = "{{content}}";
                const runtime = plugin.companion?.snapshot();
                const wasEnabled = runtime?.enabled;
                await runtime?.setEnabled?.(false);
                try {
                    Object.assign(plugin.settings, cleaned);
                    plugin.settings.sourcePropertiesTemplateInitialized=false;
                    await plugin.saveSettings();
                }
                catch (error) {
                    Object.assign(plugin.settings, before);
                    plugin.settings.sourcePropertiesTemplateInitialized=beforeInitialized;
                    if (wasEnabled)
                        await runtime?.setEnabled?.(true);
                    throw error;
                }
                plugin.app.saveLocalStorage(DESKTOP_ENABLED_KEY, false);
                confirmed = true;
                modal.close();
                resolve(true);
            })().catch(error => new Notice(error instanceof Error ? error.message : '关闭失败，配置已保留'));
        }));
        modal.open();
    });
}
export class DesktopSettingsPage extends SettingPage {
    constructor(private readonly plugin: BijiSyncPlugin) { super(); this.title = '本地剪藏扩展'; }
    private cleanup?: () => void;
    private timer?: number;
    private signature = '';
    hide(): void {
        this.cleanup?.(); this.cleanup = undefined;
        if (this.timer !== undefined) window.clearInterval(this.timer);
        this.timer = undefined;
    }
    display(): void {
        this.hide();
        const el = this.containerEl;
        el.empty();
        if (!Platform.isDesktopApp) return;
        const p = this.plugin, state = p.companion?.snapshot();
        this.signature = `${!!state?.renderSettings}:${state?.runtimeVersion || ''}`;
        if (state?.renderSettings) {
            const cleanup = state.renderSettings(el);
            if (typeof cleanup === 'function') this.cleanup = cleanup;
        } else if (BUILD_CHANNEL === 'website') {
            el.createEl('p', { text: '开启本地剪藏扩展，在本机补充原站正文、媒体、评论与字幕。首次开启会准备本地工具和固定转写资源。' });
            new Setting(el).setName('启用本地剪藏扩展').addButton(button => button.setButtonText('开启').onClick(async () => {
                await setDesktopEnabled(p, true); this.display();
            }));
        } else {
            this.cleanup = renderDependency(el, p.app, 'clipmd-desktop-tools', () => {
                const current = p.companion?.snapshot();
                const connected = p.companion?.connected() === true;
                return { connected, compatible: !connected || !!current?.setEnabled, bound: !!p.settings.apiKey };
            });
        }
        this.timer = window.setInterval(() => {
            const current = p.companion?.snapshot();
            if (`${!!current?.renderSettings}:${current?.runtimeVersion || ''}` !== this.signature) this.display();
        }, 1000);
    }
}
