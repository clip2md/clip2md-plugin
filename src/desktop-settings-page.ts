import { Modal, Notice, Platform, Setting, SettingPage } from 'obsidian';
import type BijiSyncPlugin from './main';
import { pluginInstallation } from './local-diagnostics';
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
    hide(): void { this.cleanup?.(); this.cleanup=undefined; }
    display(): void {
        this.hide();
        const el = this.containerEl;
        el.empty();
        const p = this.plugin, state = p.companion?.snapshot();
        const enabled = state?.enabled === true;
        el.createEl('p', { text: '在本机补充原站正文、媒体、评论和字幕；配置与已下载素材均保留在本地。', cls: 'clip2md-desktop-guide' });
        el.createEl('p', { text: '在 Web 端开启自动本地解析后，云端失败恢复会通过主插件上传来源标题及本机提取或转写的文本，用于云端生成智能笔记，并按账号规则使用额度。关闭 Web 端自动本地解析或本机扩展可停止后续自动处理。' });
        el.createEl('a', { text: '隐私政策', href: 'https://clip2.md/privacy' });
        new Setting(el).setName('启用本地剪藏扩展').setDesc('开启后可按平台配置登录与采集能力。')
            .addToggle(t => t.setValue(enabled).onChange(async (value) => { await setDesktopEnabled(p, value); this.display(); }));
        if (enabled && state?.renderSettings) {
            const cleanup=state.renderSettings(el);
            if(typeof cleanup==='function')this.cleanup=cleanup;
        } else {
            const overview=el.createDiv({cls:'clip2md-desktop-overview clip2md-desktop-disabled-overview'});
            overview.createEl('strong',{text:'本地剪藏未开启'});
            overview.createEl('p',{text:'开启后按平台配置补充新同步笔记；首次使用需准备本地工具。'});
        }
        if (!state)
            el.createEl('a', { text: '安装桌面扩展与安装说明', href: 'https://clip2.md/app/sync' });
        const info=el.createEl('details',{cls:'clip2md-settings-group clip2md-desktop-runtime-info'});
        info.createEl('summary',{text:'扩展信息'});
        const panel=info.createDiv({cls:'clip2md-settings-group-content'});
        const versionEl = panel.createEl('p', { text: `桌面版本：${state?.runtimeVersion || '未检测到'}${state?.message ? ` · ${state.message}` : ''}` });
        if (!state)
            void pluginInstallation(p.app.vault.adapter, p.app.vault.configDir, 'clipmd-desktop-tools').then(installed => { if (versionEl.isConnected && installed.version)
                versionEl.setText(`桌面版本：${installed.version} · 已安装，尚未启用`); });
        const instanceEl=panel.createEl('p',{text:'云端执行实例：连接中'});
        void p.localRecoveryInstance().then(id=>{if(instanceEl.isConnected)instanceEl.setText(id?`云端执行实例：${id.slice(0,6)} · 由队列自动分配`:'云端执行实例：尚未连接');});
        new Setting(el).setName('本地自动处理记录').setDesc('查看云端失败任务的本地处理状态').addButton(b => b.setButtonText('查看记录').onClick(() => { void p.openLocalRetries(); }));
    }
}
