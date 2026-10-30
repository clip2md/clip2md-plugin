import { Notice, Setting } from 'obsidian';
import type BijiSyncPlugin from './main';
import type { ArchiveConfig } from './subscriptions';
import { FolderPickerModal } from './settings';

export function action(parent: HTMLElement, label: string, run: () => void | Promise<unknown>) {
    const button = parent.createEl('button', { text: label, attr: { type: 'button' } });
    button.addEventListener('click', () => {
        button.disabled = true;
        void Promise.resolve().then(run).catch(error => new Notice(error instanceof Error ? error.message : String(error)))
            .finally(() => { button.disabled = false; });
    });
    return button;
}
export function folderSetting(container: HTMLElement, plugin: BijiSyncPlugin, title: string, value: string,
    set: (value: string) => void, canEdit: () => boolean, ariaLabel = title) {
    const setting = new Setting(container).setName(title).addText(text => {
        text.setPlaceholder('默认：主笔记目录').setValue(value).setDisabled(!canEdit()).onChange(next => { if (canEdit()) set(next); });
        text.inputEl.setAttribute('aria-label', ariaLabel);
        text.inputEl.setAttribute('data-control', title);
        text.inputEl.spellcheck = false;
    });
    setting.addExtraButton(button => button.setIcon('folder').setTooltip(`选择${title}`).setDisabled(!canEdit()).onClick(() => {
        if (!canEdit()) return;
        const input = setting.settingEl.querySelector('input');
        new FolderPickerModal(plugin.app, input?.value || '', folder => {
            if (!canEdit()) return;
            set(folder);
            if (input) input.value = folder;
        }).open();
    }));
}
export function validateConfig(plugin: BijiSyncPlugin, config: ArchiveConfig) {
    for (const path of [config.folderTemplate, config.reportFolder, ...Object.values(config.bloggers).map(r => r.folder).filter((v): v is string => !!v)]) {
        if (path.trim() && !plugin.validateTargetFolder(path)) throw new Error('目录不能包含越界路径，且不能为空');
    }
}
