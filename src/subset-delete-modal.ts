import { App, Modal, Setting } from 'obsidian';
import type { ImageMode, SyncContentMode } from './settings';

/** Closing with Escape, outside click or the close control always declines. */
export class SubsetDeleteModal extends Modal {
    private accepted = false;

    constructor(app: App, private readonly mode: SyncContentMode, private readonly resolve: (accepted: boolean) => void, private readonly imageMode: ImageMode = 'local') {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText('确认同步后删除');
        this.contentEl.createEl('p', { text: `当前同步${this.mode === 'full' ? '完整内容' : this.mode === 'source' ? '原文' : '智能笔记'}${this.imageMode === 'disabled' ? '，不保存图片' : ''}。` });
        if (this.mode !== 'full') this.contentEl.createEl('p', { text: '仅保存所选内容；删除后，未同步的内容也会从云端删除。' });
        if (this.imageMode === 'disabled') this.contentEl.createEl('p', { text: '仅保存去图后的正文；未保存的图片也会随云端任务永久删除。' });
        this.contentEl.createEl('p', { text: '此操作不可恢复。取消后仍会正常保存到 Vault，并保留云端任务。' });
        new Setting(this.contentEl)
            .addButton(button => button.setButtonText('保留云端任务').onClick(() => this.close()))
            .addButton(button => button.setButtonText('确认按所选内容删除').setWarning().onClick(() => {
                this.accepted = true;
                this.close();
            }));
    }

    onClose(): void {
        this.resolve(this.accepted);
        this.contentEl.empty();
    }
}
