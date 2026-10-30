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
    const createEl = function (this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
        const child = document.createElement(tag);
        if (options.text !== undefined) child.textContent = options.text;
        if (options.cls) child.className = options.cls;
        for (const [key, value] of Object.entries(options.attr || {})) child.setAttribute(key, value);
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
    Object.assign(view, { contentEl: document.body.createDiv(), plugin, app: {}, blogger: '', platform: '', kind: '', status: '',
        expandedTitles: new Set(), openMenus: new Set(), mode: 'attention', search: '', visibleCount: 50, filtersOpen: false, subscriptionDetailsOpen: false });
    view.render(); return { view, plugin, state, root: view.contentEl };
}
describe('subscription panel', () => {
    it('defaults to actionable work, keeps history in all view and uses Chinese platform labels', () => {
        const { view, root } = panel();
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(0);
        expect(root.textContent).toContain('没有待处理');
        view['mode'] = 'all'; view.render();
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(2);
        expect(root.querySelectorAll('select')).toHaveLength(5);
        expect(root.querySelector('select[aria-label="博主"]')).not.toBeNull();
        expect(root.querySelector('select[aria-label="平台"]')!.textContent).toContain('YouTube');
        expect(root.textContent).not.toMatch(/未读|稍后读|购买|续订/);
        const item = root.querySelector('.clip2md-subscription-list li')!;
        expect(item.textContent).toContain('历史作品'); expect(item.textContent).toContain('历史未剪藏');
    });
    it('filters local statuses and preserves keyboard focus after a refresh', () => {
        const { view, root } = panel(); view['mode'] = 'all'; view.render();
        const select = root.querySelector<HTMLSelectElement>('[data-control="状态"]')!;
        select.focus(); select.value = 'excluded'; select.dispatchEvent(new Event('change'));
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(1);
        expect(root.textContent).toContain('新作品');
        expect(document.activeElement?.getAttribute('data-control')).toBe('状态');
    });
    it('shows offline cache time and suppresses another account until credentials are verified', () => {
        const { view, plugin, state, root } = panel();
        view['mode'] = 'all'; plugin.subscriptionError = '订阅刷新失败：离线'; view.render();
        expect(root.textContent).toContain('离线'); expect(root.textContent).toContain('新作品');
        expect(root.textContent).toContain('2026-10-14 09:00:00');
        state.unverified = true; view.render();
        expect(root.textContent).not.toContain('新作品'); expect(root.textContent).not.toContain('设计博主');
    });
    it('keeps settings in the dedicated page and retains sync controls', async () => {
        const { root, plugin } = panel();
        expect(root.textContent).toContain('订阅设置');
        [...root.querySelectorAll('button')].find(b => b.textContent === '立即同步')!.click();
        await vi.waitFor(() => expect(plugin.syncNow).toHaveBeenCalledOnce());
    });
    it('searches titles and restores the caret after rendering', () => {
        const { view, root } = panel(); view['mode'] = 'all'; view.render();
        const input = root.querySelector<HTMLInputElement>('[aria-label="搜索作品标题"]')!;
        input.focus(); input.value = '新作品'; input.dispatchEvent(new Event('input'));
        const current = root.querySelector<HTMLInputElement>('[aria-label="搜索作品标题"]')!;
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(1);
        expect(root.textContent).toContain('新作品'); expect(root.textContent).not.toContain('历史作品');
        expect(document.activeElement).toBe(current); expect(current.selectionStart).toBe(3);
    });
    it('filters completed cloud work and shows one current status per item', () => {
        const { view, root, state } = panel(); state.statuses[12] = { status: 'synced' };
        view['mode'] = 'all'; view.render();
        const select = root.querySelector<HTMLSelectElement>('[data-control="云端状态"]')!;
        select.value = 'cloud-success'; select.dispatchEvent(new Event('change'));
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(1);
        const item = root.querySelector('.clip2md-subscription-list li')!;
        expect(item.textContent).toContain('已同步');
        expect(item.querySelectorAll('.clip2md-status-badge')).toHaveLength(1);
        expect(item.textContent).not.toContain('云端已完成');
    });
    it('loads 50 local results at a time without refreshing cloud data', () => {
        const { view, state, plugin, root } = panel();
        state.snapshot!.works = Array.from({ length: 123 }, (_, index) => ({
            id: index + 1, subscription_id: 2, platform: 'bilibili', work_id: `work-${index}`,
            url: `https://www.bilibili.com/video/${index}`, metadata: { caption: `作品 ${index}` }, baseline: false,
            first_discovered_at: '2026-10-14', task_id: index + 100, clip_status: 'SUCCESS', clip_outcome: null,
            supplement_task_id: null, comment_status: null,
        }));
        view.render();
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(50);
        const load = [...root.querySelectorAll('button')].find(button => button.textContent?.startsWith('加载更多'))!;
        load.focus(); load.click();
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(100);
        expect(document.activeElement?.textContent).toContain('加载更多');
        expect(plugin.refreshSubscriptionSnapshot).not.toHaveBeenCalled();
        [...root.querySelectorAll('button')].find(button => button.textContent?.startsWith('加载更多'))!.click();
        expect(root.querySelectorAll('.clip2md-subscription-list li')).toHaveLength(123);
        expect(root.textContent).toContain('123 条结果');
    });
});
