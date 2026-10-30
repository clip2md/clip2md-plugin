// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { FolderPickerModal } from './settings';

vi.mock('obsidian', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    Modal: class {
        contentEl = document.body.appendChild(document.createElement('div'));
        titleEl = document.createElement('h2');
        constructor(public app: unknown) {}
        close() { (this as unknown as FolderPickerModal).onClose(); }
    },
}));

beforeAll(() => {
    function createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
        const child = document.createElement(tag);
        if (options.text) child.textContent = options.text;
        if (options.cls) child.className = options.cls;
        for (const [key, value] of Object.entries(options.attr || {})) child.setAttribute(key, value);
        this.appendChild(child);
        return child;
    }
    Object.assign(HTMLElement.prototype, {
        createEl,
        createDiv(this: HTMLElement, options: object) { return createEl.call(this, 'div', options); },
        createSpan(this: HTMLElement, options: object) { return createEl.call(this, 'span', options); },
        empty(this: HTMLElement) { this.replaceChildren(); },
        setText(this: HTMLElement, text: string) { this.textContent = text; },
        setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
        instanceOf(this: HTMLElement, ctor: typeof HTMLElement) { return this instanceof ctor; },
    });
});
beforeEach(() => document.body.replaceChildren());

function setup(initial = '') {
    const root = Object.assign(new TFolder(), { path: '/', name: '', children: [] as TFolder[] });
    const files = new Map<string, TFile | TFolder>();
    function addFolder(path: string) {
        const folder = Object.assign(new TFolder(), { path, name: path.split('/').pop()!, children: [] as TFolder[] });
        const parent = path.includes('/') ? files.get(path.slice(0, path.lastIndexOf('/'))) as TFolder : root;
        parent.children.push(folder);
        files.set(path, folder);
        return folder;
    }
    addFolder('收藏');
    addFolder('收藏/文章');
    files.set('已存在.md', Object.assign(new TFile(), { path: '已存在.md' }));
    const createFolder = vi.fn(async (path: string) => addFolder(path));
    const vault = { getRoot: () => root, getAbstractFileByPath: (path: string) => files.get(path), createFolder };
    const onSelect = vi.fn();
    const modal = new FolderPickerModal({ vault } as never, initial, onSelect);
    modal.onOpen();
    const click = (text: string) => Array.from(modal.contentEl.querySelectorAll('button')).find(button => button.textContent === text)!.click();
    const name = (value: string) => {
        const input = modal.contentEl.querySelector<HTMLInputElement>('[data-control="new-folder-name"]')!;
        input.value = value; input.dispatchEvent(new Event('input')); return input;
    };
    const create = (value: string) => { click('新建文件夹'); name(value); click('创建'); };
    return { modal, vault, files, onSelect, createFolder, click, name, create };
}

describe('folder picker creation', () => {
    it('creates inside the selected folder, expands it and selects the new folder before confirmation', async () => {
        const page = setup('收藏/文章');
        page.create('新资料');
        await vi.waitFor(() => expect(page.modal.contentEl.querySelector('.selected')?.getAttribute('data-path')).toBe('收藏/文章/新资料'));
        expect(page.createFolder).toHaveBeenCalledWith('收藏/文章/新资料');
        expect(page.onSelect).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(page.modal.contentEl.querySelector('.selected'));
        page.click('选择此文件夹');
        expect(page.onSelect).toHaveBeenCalledWith('收藏/文章/新资料');
    });

    it.each(['', '/', '{{平台}}/不存在'])('creates at the root with no existing selection: %s', async initial => {
        const page = setup(initial);
        page.create('根目录新建');
        await vi.waitFor(() => expect(page.modal.contentEl.querySelector('.selected')?.getAttribute('data-path')).toBe('根目录新建'));
        expect(page.createFolder).toHaveBeenCalledWith('根目录新建');
    });

    it('uses the newly selected directory as parent', async () => {
        const page = setup();
        page.modal.contentEl.querySelector<HTMLButtonElement>('[data-path="收藏"]')!.click();
        page.create('资料');
        await vi.waitFor(() => expect(page.createFolder).toHaveBeenCalledWith('收藏/资料'));
    });

    it.each(['', '..', 'a/b', 'a\\b', '收藏', '已存在.md'])('rejects invalid names and existing files or directories: %s', value => {
        const page = setup();
        page.create(value);
        expect(page.createFolder).not.toHaveBeenCalled();
        expect(page.modal.contentEl.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    });

    it('keeps the entered name and selection on failure, and allows retry via Enter', async () => {
        const page = setup('收藏');
        page.createFolder.mockRejectedValueOnce(new Error('磁盘不可写'));
        page.create('资料');
        await vi.waitFor(() => expect(page.modal.contentEl.querySelector('[role="alert"]')?.textContent).toBe('磁盘不可写'));
        expect(page.modal.contentEl.querySelector('.selected')?.getAttribute('data-path')).toBe('收藏');
        const input = page.name('资料');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => expect(page.modal.contentEl.querySelector('.selected')?.getAttribute('data-path')).toBe('收藏/资料'));
        expect(page.createFolder).toHaveBeenCalledTimes(2);
    });

    it('disables actions during creation and does not reopen after closing', async () => {
        const page = setup();
        let finish!: (folder: TFolder) => void;
        page.createFolder.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        page.create('资料');
        expect(page.modal.contentEl.querySelector<HTMLButtonElement>('.clip2md-tree-item')?.disabled).toBe(true);
        expect(Array.from(page.modal.contentEl.querySelectorAll('button')).find(button => button.textContent === '选择此文件夹')?.disabled).toBe(true);
        page.click('取消');
        finish(new TFolder());
        await Promise.resolve();
        expect(page.modal.contentEl.childElementCount).toBe(0);
        expect(page.createFolder).toHaveBeenCalledTimes(1);
        expect(page.onSelect).not.toHaveBeenCalled();
    });

    it('filters folders and keeps matching descendants visible', () => {
        const page = setup('收藏');
        const search = page.modal.contentEl.querySelector<HTMLInputElement>('[data-control="folder-picker-search"]')!;
        search.value = '文章';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(page.modal.contentEl.querySelector<HTMLButtonElement>('[data-path="收藏/文章"]')).toBeTruthy();
        expect(page.modal.contentEl.textContent).toContain('收藏');
        expect(page.modal.contentEl.querySelector('.clip2md-folder-picker-empty')).toBeNull();
    });

    it('shows a useful empty state when no folder matches', () => {
        const page = setup();
        const search = page.modal.contentEl.querySelector<HTMLInputElement>('[data-control="folder-picker-search"]')!;
        search.value = '不存在';
        search.dispatchEvent(new Event('input'));
        expect(page.modal.contentEl.textContent || '').toContain('没有匹配的文件夹');
        expect(page.modal.contentEl.textContent || '').toContain('调整搜索词，或在下方新建文件夹。');
    });
});
