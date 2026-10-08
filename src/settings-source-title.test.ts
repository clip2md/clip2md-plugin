// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type BijiSyncPlugin from './main';
import { BijiSyncSettingTab, DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE, NEW_DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings } from './settings';
import { SyncService } from './sync';
import { NoteContentSettings } from './note-content-settings';
import { parse } from 'yaml';
import { MarkdownRenderer } from 'obsidian';

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
            const inputEl = document.createElement('input');
            inputEl.type = 'checkbox';
            this.controlEl.appendChild(inputEl);
            const component = {
                setValue(value: boolean) { inputEl.checked = value; return component; },
                onChange(handler: (value: boolean) => void) {
                    inputEl.addEventListener('change', () => handler(inputEl.checked));
                    return component;
                },
            };
            callback(component);
            return this;
        }

        addDropdown(callback: (component: unknown) => unknown) {
            const inputEl = document.createElement('select');
            this.controlEl.appendChild(inputEl);
            const component = {
                selectEl: inputEl,
                addOption(value: string, label: string) {
                    inputEl.add(new Option(label, value));
                    return component;
                },
                setValue(value: string) { inputEl.value = value; return component; },
                onChange(handler: (value: string) => void) {
                    inputEl.addEventListener('change', () => handler(inputEl.value));
                    return component;
                },
            };
            callback(component);
            return this;
        }

        addExtraButton(callback: (component: unknown) => unknown) {
            const component = { setIcon: () => component, setTooltip: () => component, onClick: () => component };
            callback(component);
            return this;
        }

        addButton(callback: (component: unknown) => unknown) {
            const button = document.createElement('button');
            this.controlEl.appendChild(button);
            const component = {
                setButtonText(value: string) { button.textContent = value; return component; },
                onClick(handler: () => void) { button.addEventListener('click', handler); return component; },
            };
            callback(component);
            return this;
        }
    }
    return { ...original, Setting, Component: class { load() {} unload() {} }, parseYaml: (text: string) => parse(text), MarkdownRenderer: { render: vi.fn(async (_app, text, target) => { target.textContent = text; }) } };
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
        toggleClass(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); },
        addClass(this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); },
    });
});

beforeEach(() => { document.body.replaceChildren(); });

function settingsPage() {
    const settings: BijiSyncSettings = {
        apiKey: 'api-key', installationId: 'test', settingsSchemaVersion: 3,
        syncInterval: 60, syncOnStart: false, preventReimportAfterLocalRemoval: false, targetFolder: 'Clip2MD',
        filenameTemplate: '{{created_date}}-{{title}}', filenameDateFormat: 'yyyy-MM-dd',
        template: '{{content}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
        dailyMergeFrontmatterTemplate: DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE,
        syncContentMode: 'full', imageMode: 'local', imageFolder: '',
        mergeMode: 'none',
    };
    const sync = new SyncService(settings);
    const pendingPreviews: Array<() => void> = [];
    const saveSettings = vi.fn(async () => undefined);
    const plugin = {
        settings,
        saveSettings,
        setPreventReimportAfterLocalRemoval: vi.fn(async (value: boolean) => {
            settings.preventReimportAfterLocalRemoval = value;
            await saveSettings();
        }),
        handleConnectionError: vi.fn(),
        getStatusSnapshot: () => ({ kind: 'connected', label: '已连接', description: '运行正常', runtimeState: 'idle' }),
        timers: {
            clearGroup: vi.fn(),
            clearTimeout: vi.fn(),
            setTimeout: vi.fn((callback: () => void) => { pendingPreviews.push(callback); return pendingPreviews.length; }),
        },
        getTemplatePreview: () => sync.getTemplatePreviewData(),
        renderTemplatePreview: (target?: 'single' | 'daily') => sync.renderTemplatePreview(settings.template, target),
        renderDailyMergeFrontmatterPreview: () => sync.renderDailyMergeFrontmatterPreview(),
        validateTemplate: (template: string) => sync.validateTemplate(template),
        getMigrationUnresolvedTasks: () => [],
        hasLegacySharedState: () => false,
    } as unknown as BijiSyncPlugin;
    const tab = Object.create(BijiSyncSettingTab.prototype) as BijiSyncSettingTab;
    tab.plugin = plugin;
    const container = document.body.createDiv();
    return { tab, plugin, container, flushPreviews: () => { pendingPreviews.splice(0).forEach(callback => callback()); } };
}

function setup(template = '{{content}}') {
    const page = settingsPage();
    page.plugin.settings.template = template;
    const state = { expanded: true, source: true };
    const view = new NoteContentSettings(page.plugin, page.container, state);
    const editors = page.container.querySelectorAll('textarea');
    return { ...page, view, state, properties: editors[0], daily: editors[1], body: editors[2] };
}
function click(container: HTMLElement, text: string) {
    Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)!.click();
}
function input(editor: HTMLTextAreaElement, value: string) {
    editor.value = value;
    editor.dispatchEvent(new Event('input'));
}

describe('unified note content settings', () => {
    it('preserves layouts and properties for all content choices', () => {
        const p = setup('# {{title}}\n{{content}}\n{{url}}');
        const mode = p.container.querySelector('select')!;
        for (const value of ['full', 'note', 'source']) {
            mode.value = value; mode.dispatchEvent(new Event('change'));
            p.flushPreviews();
            expect(p.plugin.settings.template).toBe('# {{title}}\n{{content}}\n{{url}}');
            expect(p.plugin.settings.syncContentMode).toBe(value);
            expect(p.container.querySelector('.clip2md-content-preview')!.textContent).toContain('title:');
        }
        p.view.dispose();
    });
    it.each(['{{note_content}}', '  {{source_content}}  ', '# {{title}}'])('preserves custom body %s and supports restore with undo', template => {
        const p = setup(template);
        expect(p.container.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true);
        expect(p.plugin.settings.template).toBe(template);
        click(p.container, '恢复标准正文');
        expect(p.body.value).toBe('{{content}}');
        expect(p.container.querySelector<HTMLSelectElement>('select')!.disabled).toBe(false);
        click(p.container, '撤销恢复');
        expect(p.body.value).toBe(template);
        input(p.body, '{{content}}');
        expect(p.container.querySelector<HTMLSelectElement>('select')!.disabled).toBe(false);
        p.view.dispose();
    });
    it('inserts variables at selection while retaining focus, cursor and editor identity', () => {
        const p = setup('replace\n{{content}}');
        p.body.setSelectionRange(0, 7);
        click(p.body.closest('.clip2md-content-editor')!, '原始标题 {{source_title}}');
        p.flushPreviews();
        expect(p.body.value).toBe('{{source_title}}\n{{content}}');
        expect(document.activeElement).toBe(p.body);
        expect(p.body.selectionStart).toBe('{{source_title}}'.length);
        expect(p.container.querySelectorAll('textarea')[2]).toBe(p.body);
        expect(p.container.querySelector('.clip2md-content-preview')!.textContent).toContain('示例原文');
        p.view.dispose();
    });
    it('resets only the selected properties editor', () => {
        const p = setup('# {{title}}');
        click(p.properties.closest('.clip2md-content-editor')!, '恢复默认属性');
        expect(p.properties.value).toBe(NEW_DEFAULT_FRONTMATTER_TEMPLATE);
        expect(p.body.value).toBe('# {{title}}');
        expect(p.daily.value).toBe(DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE);
        p.view.dispose();
    });
    it('shows body YAML migration and focuses the relevant editor', () => {
        const p = setup('---\ntitle: duplicate\n---\n{{content}}');
        expect(p.container.querySelector('[role=alert]')!.textContent).toContain('请将 YAML');
        click(p.container, '定位到正文模板');
        expect(document.activeElement).toBe(p.body);
        p.view.dispose();
    });
    it('reports malformed property YAML while keeping source available', () => {
        const p = setup();
        input(p.properties, '---\ntitle: [broken\n---');
        p.flushPreviews();
        expect(p.container.querySelector('[role=alert]')!.textContent).toContain('属性 YAML 无效');
        expect(p.container.querySelector('pre')!.textContent).toContain('[broken');
        click(p.container, '定位到属性模板');
        expect(document.activeElement).toBe(p.properties);
        p.view.dispose();
    });
    it('previews two daily tasks and switches editing context without changing merge mode', () => {
        const p = setup();
        const [, merge, target] = p.container.querySelectorAll('select');
        merge.value = 'daily'; merge.dispatchEvent(new Event('change')); p.flushPreviews();
        expect(target.value).toBe('daily');
        expect(p.container.querySelector('pre')!.textContent).toContain('task_count: 2');
        expect(p.container.querySelector('pre')!.textContent).toContain('第二篇网站标题');
        target.value = 'single'; target.dispatchEvent(new Event('change'));
        expect(p.plugin.settings.mergeMode).toBe('daily');
        expect(p.properties.closest<HTMLElement>('.clip2md-content-editor')!.hidden).toBe(false);
        expect(p.daily.closest<HTMLElement>('.clip2md-content-editor')!.hidden).toBe(true);
        p.view.dispose();
    });
    it('does not append stale asynchronous renders after edits or disposal', async () => {
        const pending: Array<() => void> = [];
        vi.mocked(MarkdownRenderer.render).mockImplementation((_app, text, target) => new Promise<void>(resolve => {
            pending.push(() => { target.textContent = text; resolve(); });
        }));
        const p = setup();
        const format = p.container.querySelectorAll('select')[3];
        format.value = 'note'; format.dispatchEvent(new Event('change'));
        input(p.body, '# newest\n{{content}}'); p.flushPreviews();
        pending[0](); await Promise.resolve();
        expect(p.container.querySelector('.clip2md-note-body')).toBeNull();
        pending[1](); await Promise.resolve();
        expect(p.container.querySelector('.clip2md-note-body')!.textContent).toContain('# newest');
        input(p.body, '# disposed\n{{content}}'); p.flushPreviews();
        p.view.dispose(); pending[2](); await Promise.resolve();
        expect(p.container.querySelector('.clip2md-note-body')).toBeNull();
        vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, text, target) => { target.textContent = text; });
    });
    it('updates status without replacing editors, selections, scroll or disclosure state', () => {
        const { tab, plugin, container } = settingsPage();
        tab['activeContainerEl'] = container;
        tab['renderStatusBar'](container);
        tab['renderAdvancedSettings'](container);
        const advanced = container.querySelector('details')!;
        advanced.open = true;
        const body = container.querySelectorAll('textarea')[2];
        body.focus(); body.setSelectionRange(1, 4);
        container.scrollTop = 120;
        plugin.getStatusSnapshot = (() => ({ kind: 'syncing', label: '同步中', description: '处理中', runtimeState: 'syncing' })) as typeof plugin.getStatusSnapshot;
        tab.refresh(); tab.onAppVisibilityChange(true);
        expect(container.querySelectorAll('textarea')[2]).toBe(body);
        expect(document.activeElement).toBe(body);
        expect(body.selectionStart).toBe(1);
        expect(body.selectionEnd).toBe(4);
        expect(advanced.open).toBe(true);
        expect(container.scrollTop).toBe(120);
        expect(container.querySelector('.clip2md-status-indicator')!.textContent).toBe('同步中');
        expect(container.querySelector<HTMLButtonElement>('[data-clip2md-action="sync"]')!.disabled).toBe(true);
        expect(container.querySelector('.clip2md-note-content')!.closest('details')).toBe(advanced);
        tab['releaseActivePage']();
    });
    it('refreshes only a changed binding region while retaining the template editor', () => {
        const { tab, plugin, container } = settingsPage();
        tab['activeContainerEl'] = container;
        tab['bindingMode'] = 'qr';
        const binding = container.createDiv({ cls: 'clip2md-binding-region' });
        const renderBinding = vi.fn((target: HTMLElement) => { target.textContent = plugin.getDeviceBindingMessage(); });
        tab['renderQrOnboarding'] = renderBinding;
        plugin.getDeviceBindingSession = vi.fn(() => null);
        plugin.getDeviceBindingMessage = vi.fn(() => '等待授权');
        tab['renderAdvancedSettings'](container);
        const body = container.querySelectorAll('textarea')[2];
        body.focus(); body.setSelectionRange(2, 5);
        tab.refresh(); tab.refresh();
        expect(renderBinding).toHaveBeenCalledOnce();
        plugin.getDeviceBindingMessage = vi.fn(() => '授权处理中');
        tab.refresh();
        expect(binding.textContent).toBe('授权处理中');
        expect(renderBinding).toHaveBeenCalledTimes(2);
        expect(container.querySelectorAll('textarea')[2]).toBe(body);
        expect(document.activeElement).toBe(body);
        expect(body.selectionStart).toBe(2);
        expect(body.selectionEnd).toBe(5);
        tab['releaseActivePage'](); tab.refresh();
        expect(renderBinding).toHaveBeenCalledTimes(2);
    });
    it('saves title choices and rejects recursive custom title templates', async () => {
        const { tab, plugin, container } = settingsPage();
        tab['renderAdvancedContent'](container);
        const rows = [...container.querySelectorAll('.setting-item')];
        const mode = rows.find(row => row.querySelector('.setting-item-name')?.textContent === '笔记标题')!.querySelector('select')!;
        mode.value = 'custom'; mode.dispatchEvent(new Event('change'));
        const custom = rows.find(row => row.querySelector('.setting-item-name')?.textContent === '自定义标题模板')!;
        const editor = custom.querySelector('input')!;
        input(editor as unknown as HTMLTextAreaElement, '{{note_title}}');
        expect(custom.textContent).toContain('标题模板不支持');
        expect(plugin.settings.customTitleTemplate).toBeUndefined();
        input(editor as unknown as HTMLTextAreaElement, '{{source_title}} · {{task_id}}');
        await Promise.resolve();
        expect(plugin.settings.customTitleTemplate).toBe('{{source_title}} · {{task_id}}');
        tab['releaseActivePage']();
    });
    it('saves the per-Vault local removal toggle from advanced settings', async () => {
        const { tab, plugin, container } = settingsPage();
        tab['renderAdvancedContent'](container);
        const setting = Array.from(container.querySelectorAll('.setting-item'))
            .find(element => element.querySelector('.setting-item-name')?.textContent === '本地删除或改名后不再补回');
        const toggle = setting?.querySelector<HTMLInputElement>('input[type="checkbox"]');

        expect(toggle?.checked).toBe(false);
        expect(setting?.textContent).toContain('仅对当前 Vault 生效');
        toggle!.checked = true;
        toggle!.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(plugin.settings.preventReimportAfterLocalRemoval).toBe(true);
        expect(plugin.saveSettings).toHaveBeenCalledOnce();
    });

    it('describes source title support in paths and shows it in the folder and filename preview', () => {
        const { tab, plugin, container } = settingsPage();
        plugin.settings.targetFolder = 'Clip2MD/{{source_title}}';
        plugin.settings.filenameTemplate = '{{source_title}}-{{title}}';
        tab['renderBasicSettings'](container);
        tab['renderAdvancedContent'](container);

        const descriptions = Array.from(container.querySelectorAll('.setting-item-description')).map(element => element.textContent);
        expect(descriptions.some(description => description?.includes('可使用 {{title}}、{{source_title}} 等变量'))).toBe(true);
        expect(descriptions.some(description => description?.includes('{{note_title}} 跟随标题选择'))).toBe(true);
        expect(container.textContent).toContain('示例目录：Clip2MD/示例原文');
        expect(container.textContent).toContain('示例文件：示例原文-Clip2MD 使用示例.md');
    });

});
