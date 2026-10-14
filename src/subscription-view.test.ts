// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type BijiSyncPlugin from './main';
import { SubscriptionView } from './subscription-view';
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
function panel() {
    const state = newSubscriptionState(); state.accountId = 'account-a';
    state.snapshot = { account_id: 'account-a', features: {}, fetchedAt: '2026-10-14T01:00:00Z', items: [
        { id: 2, platform: 'youtube', blogger_id: 'UC-test', name: '设计博主', profile: {}, homepage: 'https://youtube.com/@test', ends_at: '2026-11-01', last_scan: null },
    ], works: [
        { id: 1, subscription_id: 2, platform: 'youtube', work_id: 'old', url: 'https://youtube.com/watch?v=old', metadata: { caption: '历史作品' }, baseline: true, first_discovered_at: '2026-10-12', task_id: null, clip_status: null, clip_outcome: null, supplement_task_id: null, comment_status: null },
        { id: 2, subscription_id: 2, platform: 'youtube', work_id: 'new', url: 'https://youtube.com/watch?v=new', metadata: { caption: '新作品' }, baseline: false, first_discovered_at: '2026-10-14', task_id: 12, clip_status: 'SUCCESS', clip_outcome: null, supplement_task_id: null, comment_status: null },
    ], reports: [] };
    state.statuses[12] = { status: 'excluded' };
    const plugin = { getSubscriptionState: () => state, getSubscriptionConfig: () => archiveConfig(), getSubscriptionNotes: () => [],
        subscriptionError: '', subscriptionArchiveErrors: [], subscriptionIndexConflicts: [],
        syncService: { getIgnoredTaskIds: () => [] }, app: {},
        refreshSubscriptionSnapshot: vi.fn(async () => {}), rebuildSubscriptions: vi.fn(async () => {}),
        syncNow: vi.fn(async () => {}), openSubscriptionPanel: vi.fn(async () => {}),
        updateSubscriptionConfig: vi.fn(async () => {}), validateTargetFolder: (path: string) => !path.includes('..'),
        previewSubscriptionFolders: () => '示例目录',
    } as unknown as BijiSyncPlugin;
    const view = Object.create(SubscriptionView.prototype) as SubscriptionView;
    Object.assign(view, { contentEl: document.body.createDiv(), plugin, app: {}, blogger: '', platform: '', kind: '', status: '' });
    view.render(); return { view, plugin, state, root: view.contentEl };
}
describe('subscription panel', () => {
    it('renders scoped statuses, history and labeled filters without reading or purchase controls', () => {
        const { root } = panel();
        expect(root.textContent).toContain('历史基线'); expect(root.textContent).toContain('已排除');
        expect(root.querySelectorAll('select')).toHaveLength(4);
        expect(root.querySelector('select[aria-label="博主"]')).not.toBeNull();
        expect(root.textContent).not.toMatch(/未读|稍后读|购买|续订/);
    });
    it('filters local statuses and preserves keyboard focus after a refresh', () => {
        const { root } = panel();
        const select = root.querySelector<HTMLSelectElement>('[data-control="状态"]')!;
        select.focus(); select.value = 'excluded'; select.dispatchEvent(new Event('change'));
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(1);
        expect(root.textContent).toContain('新作品');
        expect(document.activeElement?.getAttribute('data-control')).toBe('状态');
    });
    it('shows offline cache time and suppresses another account until credentials are verified', () => {
        const { view, plugin, state, root } = panel();
        plugin.subscriptionError = '订阅刷新失败：离线'; view.render();
        expect(root.textContent).toContain('离线'); expect(root.textContent).toContain('新作品');
        expect(root.textContent).toContain('2026-10-14T01:00:00Z');
        state.unverified = true; view.render();
        expect(root.textContent).not.toContain('新作品'); expect(root.textContent).not.toContain('设计博主');
    });
    it('retains unsaved directory drafts, open settings and input focus during background refresh', () => {
        const { view, root, plugin } = panel();
        root.querySelector('details')!.open = true;
        const field = root.querySelector<HTMLInputElement>('input[aria-label="博主目录模板"]')!;
        field.focus(); field.value = '学习/{{blogger_name}}'; field.dispatchEvent(new Event('input'));
        view.render();
        expect(root.querySelector<HTMLInputElement>('input[aria-label="博主目录模板"]')!.value).toBe('学习/{{blogger_name}}');
        expect(root.querySelector('details')!.open).toBe(true);
        expect(document.activeElement?.getAttribute('data-control')).toBe('博主目录模板');
        expect(plugin.updateSubscriptionConfig).not.toHaveBeenCalled();
    });
    it('saves configuration only on explicit save and can trigger sync by keyboard-native button', async () => {
        const { root, plugin } = panel();
        const toggle = root.querySelector<HTMLInputElement>('.clip2md-subscription-settings input[type="checkbox"]')!;
        toggle.checked = true; toggle.dispatchEvent(new Event('change'));
        expect(plugin.updateSubscriptionConfig).not.toHaveBeenCalled();
        [...root.querySelectorAll('button')].find(b => b.textContent === '保存订阅配置')!.click();
        await vi.waitFor(() => expect(plugin.updateSubscriptionConfig).toHaveBeenCalledOnce());
        [...root.querySelectorAll('button')].find(b => b.textContent === '立即同步')!.click();
        await vi.waitFor(() => expect(plugin.syncNow).toHaveBeenCalledOnce());
    });
});
