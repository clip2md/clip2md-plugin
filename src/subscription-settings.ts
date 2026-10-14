import { Notice, Setting } from 'obsidian';
import type BijiSyncPlugin from './main';
import { archiveConfig, bloggerName, type ArchiveConfig } from './subscriptions';
import { FolderPickerModal } from './settings';

export function action(parent: HTMLElement, label: string, run: () => void | Promise<unknown>) {
    const button = parent.createEl('button', { text: label, attr: { type: 'button' } });
    button.addEventListener('click', () => {
        button.disabled = true;
        void Promise.resolve().then(run).catch(error => new Notice(String(error))).finally(() => { button.disabled = false; });
    });
    return button;
}
function folderSetting(container: HTMLElement, plugin: BijiSyncPlugin, title: string, value: string, set: (value: string) => void) {
    const setting = new Setting(container).setName(title).addText(text => {
        text.setValue(value).onChange(set);
        text.inputEl.setAttribute('aria-label', title);
        text.inputEl.setAttribute('data-control', title);
    });
    setting.addExtraButton(button => button.setIcon('folder').setTooltip(`选择${title}`).onClick(() => {
        new FolderPickerModal(plugin.app, value, folder => {
            set(folder || 'Clip2MD');
            const input = setting.settingEl.querySelector('input'); if (input) input.value = folder || 'Clip2MD';
        }).open();
    }));
}
export function renderSubscriptionSettings(container: HTMLElement, plugin: BijiSyncPlugin, draft?: ArchiveConfig): ArchiveConfig | undefined {
    const root = container.createDiv({ cls: 'clip2md-subscription-settings' });
    new Setting(root).setName('博主订阅').setHeading();
    root.createEl('p', { text: '作品、评论补充和日报的同步与归档规则，仅作用于当前知识库和账号。', cls: 'setting-item-description' });
    action(root, '打开订阅面板', () => plugin.openSubscriptionPanel());
    if (plugin.subscriptionError) root.createEl('p', { text: plugin.subscriptionError, attr: { role: 'status' } });
    const state = plugin.getSubscriptionState();
    if (!state.accountId || state.unverified) {
        action(root, '加载当前账号订阅', async () => {
            await plugin.refreshSubscriptionSnapshot(); root.empty(); renderSubscriptionSettings(root, plugin);
        });
        return;
    }
    const config = draft || archiveConfig(plugin.getSubscriptionConfig());
    config.bloggers = structuredClone(config.bloggers);
    root.createEl('p', { text: `账号：${state.accountId}` });
    new Setting(root).setName('订阅内容分目录').addToggle(toggle => toggle.setValue(config.enabled).onChange(value => { config.enabled = value; }));
    folderSetting(root, plugin, '博主目录模板', config.folderTemplate, value => { config.folderTemplate = value; });
    root.createEl('p', { text: '支持 {{platform}}、{{blogger_name}}、{{blogger_id}}、{{subscription_id}}；目录或名称变更仅影响新文件。', cls: 'setting-item-description' });
    new Setting(root).setName('自动生成博主索引').addToggle(toggle => toggle.setValue(config.indexEnabled).onChange(value => { config.indexEnabled = value; }));
    new Setting(root).setName('同步已有日报笔记').addToggle(toggle => toggle.setValue(config.reportsEnabled).onChange(value => { config.reportsEnabled = value; }));
    folderSetting(root, plugin, '日报目录', config.reportFolder, value => { config.reportFolder = value; });
    for (const sub of state.snapshot?.items || []) {
        const name = sub.name || sub.profile?.nickname || sub.blogger_id;
        const rule = config.bloggers[sub.id] ??= { enabled: true };
        new Setting(root).setName(`${name} · ${sub.platform}`).setDesc('作品及对应评论补充；关闭不会删除已有笔记或取消云端订阅。')
            .addToggle(toggle => toggle.setValue(rule.enabled !== false).onChange(value => { rule.enabled = value; }));
        folderSetting(root, plugin, `${name}指定目录（留空跟随模板）`, rule.folder || '', value => { rule.folder = value; });
    }
    const preview = root.createEl('p', { cls: 'setting-item-description' });
    action(root, '预览目录', () => {
        validateConfig(plugin, config);
        preview.textContent = plugin.previewSubscriptionFolders(config);
    });
    action(root, '保存订阅配置', async () => {
        validateConfig(plugin, config);
        await plugin.updateSubscriptionConfig(config);
        new Notice('订阅配置已保存，仅影响新文件；点击同步应用同步范围');
    });
    return config;
}
function validateConfig(plugin: BijiSyncPlugin, config: ArchiveConfig) {
    for (const path of [config.folderTemplate, config.reportFolder, ...Object.values(config.bloggers).map(r => r.folder).filter(Boolean)]) {
        if (!plugin.validateTargetFolder(path!)) throw new Error('目录不能包含越界路径，且不能为空');
    }
}
