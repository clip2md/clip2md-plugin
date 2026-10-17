// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type BijiSyncPlugin from './main';
import { SubscriptionSettingsPage } from './subscription-settings-page';
import { archiveConfig, newSubscriptionState } from './subscriptions';

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
                setDisabled(value: boolean) { inputEl.disabled = value; return component; },
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
                toggleEl: inputEl,
                setDisabled(value: boolean) { inputEl.disabled = value; return component; },
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
                setDisabled(value: boolean) { inputEl.disabled = value; return component; },
                onChange(handler: (value: string) => void) {
                    inputEl.addEventListener('change', () => handler(inputEl.value));
                    return component;
                },
            };
            callback(component);
            return this;
        }

        addExtraButton(callback: (component: unknown) => unknown) {
            const component = { setIcon: () => component, setTooltip: () => component, setDisabled: () => component, onClick: () => component };
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
    return { ...original, Setting, SettingPage: class { hide() {} }, Component: class { load() {} unload() {} }, parseYaml: (text: string) => parse(text), MarkdownRenderer: { render: vi.fn(async (_app, text, target) => { target.textContent = text; }) } };
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

function pageFixture() {
    const state = newSubscriptionState(); state.accountId = 'account-a';
    state.snapshot = { account_id: 'account-a', features: {}, fetchedAt: '2026-10-17', works: [], reports: [], items: [
        { id: 2, platform: 'youtube', blogger_id: 'UC-test', name: '设计博主', profile: {}, homepage: 'https://youtube.com/@test', ends_at: '2026-11-01', last_scan: null },
    ] };
    const listeners = new Set<() => void>();
    let generation = 0;
    let saved = archiveConfig();
    const plugin = {
        settings: { apiKey: 'key-a' }, subscriptionLoading: false, subscriptionError: '', subscriptionErrorKind: null,
        getCredentialGeneration: () => generation, getSubscriptionState: () => state,
        getSubscriptionConfig: () => saved,
        subscribeSubscriptionChanges: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        refreshSubscriptionSnapshot: vi.fn(async () => {}), openSubscriptionPanel: vi.fn(async () => {}),
        updateSubscriptionConfig: vi.fn(async (value) => { saved = archiveConfig(value); }),
        validateTargetFolder: (value: string) => !!value && !value.includes('..'),
        previewSubscriptionFolders: () => '预览目录',
    } as unknown as BijiSyncPlugin;
    const page = new SubscriptionSettingsPage(plugin);
    page.containerEl = document.body.createDiv(); page.display();
    const emit = () => { for (const listener of listeners) listener(); };
    const field = () => page.containerEl.querySelector<HTMLInputElement>('[aria-label="博主目录模板"]')!;
    const button = (label: string) => [...page.containerEl.querySelectorAll('button')].find(b => b.textContent === label)!;
    return { page, plugin, state, listeners, emit, field, button, changeCredential: () => { generation++; state.unverified = true; emit(); } };
}
describe('subscription settings page', () => {
    it('preserves draft, focus, selection and expanded sections during background refresh without saving', () => {
        const f = pageFixture(); const input = f.field();
        input.closest('details')!.open = true;
        input.closest('details')!.dispatchEvent(new Event('toggle'));
        input.value = '学习/{{blogger_name}}'; input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(1, 3);
        f.emit();
        expect(f.field().value).toBe('学习/{{blogger_name}}');
        expect(document.activeElement).toBe(f.field()); expect(f.field().selectionStart).toBe(1); expect(f.field().selectionEnd).toBe(3);
        expect(f.field().closest('details')!.open).toBe(true);
        expect(f.page.containerEl.textContent).toContain('未保存'); expect(f.plugin.updateSubscriptionConfig).not.toHaveBeenCalled();
    });
    it('disables writes while saving and establishes the submitted baseline after success', async () => {
        const f = pageFixture(); let finish!: () => void;
        vi.mocked(f.plugin.updateSubscriptionConfig).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        f.field().value = '学习'; f.field().dispatchEvent(new Event('input')); f.button('保存订阅配置').click();
        await vi.waitFor(() => expect(f.plugin.updateSubscriptionConfig).toHaveBeenCalledOnce());
        expect(f.field().disabled).toBe(true); expect(f.button('重置').disabled).toBe(true); expect(f.button('保存订阅配置').disabled).toBe(true);
        finish(); await vi.waitFor(() => expect(f.field().disabled).toBe(false));
        expect(f.page.containerEl.textContent).not.toContain('未保存');
    });
    it('retains failed drafts and resets to saved configuration', async () => {
        const f = pageFixture(); vi.mocked(f.plugin.updateSubscriptionConfig).mockRejectedValueOnce(new Error('写入失败'));
        f.field().value = '草稿'; f.field().dispatchEvent(new Event('input')); f.button('保存订阅配置').click();
        await vi.waitFor(() => expect(f.page.containerEl.textContent).toContain('写入失败'));
        expect(f.field().value).toBe('草稿'); f.button('重置').click();
        await vi.waitFor(() => expect(f.field().value).toBe(archiveConfig().folderTemplate));
    });
    it('hides unverified account data, discards its draft and unregisters on hide', () => {
        const f = pageFixture(); f.field().value = '旧草稿'; f.field().dispatchEvent(new Event('input'));
        f.changeCredential(); expect(f.page.containerEl.textContent).not.toContain('设计博主'); expect(f.field()).toBeNull();
        f.state.unverified = false; f.emit(); expect(f.field().value).toBe(archiveConfig().folderTemplate);
        f.page.display(); expect(f.listeners.size).toBe(1); f.page.hide(); expect(f.listeners.size).toBe(0);
    });
    it('does not show stale save feedback after a credential switch', async () => {
        const f = pageFixture(); let fail!: (error: Error) => void;
        vi.mocked(f.plugin.updateSubscriptionConfig).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
        f.button('保存订阅配置').click(); await vi.waitFor(() => expect(f.plugin.updateSubscriptionConfig).toHaveBeenCalledOnce());
        f.changeCredential(); fail(new Error('旧账号保存失败'));
        await vi.waitFor(() => expect(f.page.containerEl.getAttribute('aria-busy')).toBe('false'));
        expect(f.page.containerEl.textContent).not.toContain('旧账号保存失败');
    });
});
