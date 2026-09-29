// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type BijiSyncPlugin from './main';
import { BijiSyncSettingTab, DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings } from './settings';
import { SyncService } from './sync';

vi.mock('obsidian', async importOriginal => {
    const original = await importOriginal<Record<string, unknown>>();
    class Setting {
        settingEl: HTMLDivElement;
        controlEl: HTMLDivElement;

        constructor(containerEl: HTMLElement) {
            this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
            this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
        }

        setName(name: string) { this.settingEl.createDiv({ cls: 'setting-item-name', text: name }); return this; }
        setDesc(desc: string) { this.settingEl.createDiv({ cls: 'setting-item-description', text: desc }); return this; }
        setHeading() { return this; }

        addInput(tag: 'input' | 'textarea', callback: (component: unknown) => unknown) {
            const inputEl = document.createElement(tag);
            this.controlEl.appendChild(inputEl);
            const component = {
                inputEl,
                setValue(value: string) { inputEl.value = value; return component; },
                setPlaceholder(value: string) { inputEl.placeholder = value; return component; },
                onChange(handler: (value: string) => void) {
                    inputEl.addEventListener('input', () => handler(inputEl.value));
                    return component;
                },
            };
            callback(component);
            return this;
        }

        addText(callback: (component: unknown) => unknown) { return this.addInput('input', callback); }
        addTextArea(callback: (component: unknown) => unknown) { return this.addInput('textarea', callback); }

        addToggle(callback: (component: unknown) => unknown) {
            const component = { setValue: () => component, onChange: () => component };
            callback(component);
            return this;
        }

        addDropdown(callback: (component: unknown) => unknown) {
            const component = { addOption: () => component, setValue: () => component, onChange: () => component };
            callback(component);
            return this;
        }

        addExtraButton(callback: (component: unknown) => unknown) {
            const component = { setIcon: () => component, setTooltip: () => component, onClick: () => component };
            callback(component);
            return this;
        }
    }
    return { ...original, Setting };
});

beforeAll(() => {
    const createEl = function (this: HTMLElement, tag: string, options: { text?: string; cls?: string } = {}) {
        const child = document.createElement(tag);
        if (options.text !== undefined) child.textContent = options.text;
        if (options.cls) child.className = options.cls;
        this.appendChild(child);
        return child;
    };
    Object.assign(HTMLElement.prototype, {
        createEl,
        createDiv(this: HTMLElement, options: { text?: string; cls?: string } = {}) { return createEl.call(this, 'div', options); },
        createSpan(this: HTMLElement, options: { text?: string; cls?: string } = {}) { return createEl.call(this, 'span', options); },
        empty(this: HTMLElement) { this.replaceChildren(); },
        setText(this: HTMLElement, text: string) { this.textContent = text; },
        addClass(this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); },
    });
});

beforeEach(() => { document.body.replaceChildren(); });

function settingsPage() {
    const settings: BijiSyncSettings = {
        apiKey: 'api-key', installationId: 'test', settingsSchemaVersion: 3,
        syncInterval: 60, syncOnStart: false, targetFolder: 'Clip2MD',
        filenameTemplate: '{{created_date}}-{{title}}', filenameDateFormat: 'yyyy-MM-dd',
        template: '{{content}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
        syncContentMode: 'full', imageMode: 'local', imageFolder: '',
        mergeMode: 'none',
    };
    const sync = new SyncService(settings);
    const pendingPreviews: Array<() => void> = [];
    const plugin = {
        settings,
        saveSettings: vi.fn(async () => undefined),
        handleConnectionError: vi.fn(),
        timers: {
            clearTimeout: vi.fn(),
            setTimeout: vi.fn((callback: () => void) => { pendingPreviews.push(callback); return pendingPreviews.length; }),
        },
        getTemplatePreview: () => sync.getTemplatePreviewData(),
        renderTemplatePreview: () => sync.renderTemplatePreview(settings.template),
        validateTemplate: (template: string) => sync.validateTemplate(template),
    } as unknown as BijiSyncPlugin;
    const tab = Object.create(BijiSyncSettingTab.prototype) as BijiSyncSettingTab;
    tab.plugin = plugin;
    const container = document.body.createDiv();
    return { tab, plugin, container, flushPreviews: () => { pendingPreviews.splice(0).forEach(callback => callback()); } };
}

function sourceTitleButton(container: HTMLElement) {
    return Array.from(container.querySelectorAll('button')).find(button => button.textContent === '{{source_title}}')!;
}

describe('source title settings', () => {
    it('inserts the frontmatter variable at the selection and previews distinct titles as text', async () => {
        const { tab, plugin, container, flushPreviews } = settingsPage();
        plugin.settings.frontmatterTemplate = '---\ntitle: "{{title}}"\nsource_title: "replace"\nprobe: "<img src=x>"\n---';
        tab['renderFrontmatterSection'](container);
        const editor = container.querySelector('textarea')!;
        const start = editor.value.indexOf('replace');
        editor.setSelectionRange(start, start + 'replace'.length);
        const button = sourceTitleButton(container);

        expect(button).toBeInstanceOf(HTMLButtonElement);
        button.focus();
        expect(document.activeElement).toBe(button);
        button.click();
        await Promise.resolve();
        flushPreviews();

        expect(plugin.settings.frontmatterTemplate).toContain('source_title: "{{source_title}}"');
        expect(editor.selectionStart).toBe(start + '{{source_title}}'.length);
        expect(editor.selectionEnd).toBe(editor.selectionStart);
        expect(document.activeElement).toBe(editor);
        expect(plugin.saveSettings).toHaveBeenCalledOnce();
        expect(container.querySelector('.clip2md-fm-preview')?.textContent).toContain('title: "示例标题"\nsource_title: "示例原文"');
        expect(container.querySelector('.clip2md-fm-preview')?.textContent).toContain('<img src=x>');
        expect(container.querySelector('img')).toBeNull();
    });

    it('inserts the Markdown variable at the selection and updates the actual template preview', async () => {
        const { tab, plugin, container } = settingsPage();
        plugin.settings.template = '# {{title}}\n原文：replace\n<img src=x>\n{{content}}';
        tab['renderMarkdownTemplateSection'](container);
        const editor = container.querySelector('textarea')!;
        const start = editor.value.indexOf('replace');
        editor.setSelectionRange(start, start + 'replace'.length);

        sourceTitleButton(container).click();
        await Promise.resolve();

        expect(plugin.settings.template).toContain('原文：{{source_title}}');
        expect(editor.selectionStart).toBe(start + '{{source_title}}'.length);
        expect(editor.selectionEnd).toBe(editor.selectionStart);
        expect(document.activeElement).toBe(editor);
        expect(plugin.saveSettings).toHaveBeenCalledOnce();
        const preview = container.querySelector('.clip2md-template-preview');
        expect(preview?.textContent).toContain('# Clip2MD 使用示例\n原文：示例原文');
        expect(preview?.textContent).toContain('<img src=x>');
        expect(preview?.querySelector('img')).toBeNull();
    });

    it('describes source title support in paths and shows it in the folder and filename preview', () => {
        const { tab, plugin, container } = settingsPage();
        plugin.settings.targetFolder = 'Clip2MD/{{source_title}}';
        plugin.settings.filenameTemplate = '{{source_title}}-{{title}}';
        tab['renderBasicSettings'](container);
        tab['renderAdvancedContent'](container);

        const descriptions = Array.from(container.querySelectorAll('.setting-item-description')).map(element => element.textContent);
        expect(descriptions.some(description => description?.includes('可使用 {{title}}、{{source_title}} 等变量'))).toBe(true);
        expect(descriptions.some(description => description?.includes('可使用 {{source_title}} 引用来源标题'))).toBe(true);
        expect(container.textContent).toContain('示例目录：Clip2MD/示例原文');
        expect(container.textContent).toContain('示例文件：示例原文-Clip2MD 使用示例.md');
    });

    it('restores the unchanged default frontmatter without adding an optional source title', async () => {
        const { tab, plugin, container } = settingsPage();
        plugin.settings.frontmatterTemplate = '---\nsource_title: "{{source_title}}"\n---';
        tab['renderFrontmatterSection'](container);
        const reset = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '恢复默认')!;

        reset.click();
        await Promise.resolve();

        expect(plugin.settings.frontmatterTemplate).toBe(DEFAULT_FRONTMATTER_TEMPLATE);
        expect(container.querySelector('textarea')?.value).toBe(DEFAULT_FRONTMATTER_TEMPLATE);
        expect(plugin.settings.frontmatterTemplate).not.toContain('{{source_title}}');
        expect(container.querySelector('.clip2md-fm-preview')?.textContent).not.toContain('source_title:');
    });
});
