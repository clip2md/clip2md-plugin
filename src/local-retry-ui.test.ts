// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
const modalInstances = vi.hoisted(() => [] as Array<{ contentEl: HTMLElement; open: boolean; onClose: () => void }>);
vi.mock('obsidian', async () => ({
    ...await vi.importActual<Record<string, unknown>>('obsidian'),
    requestUrl: request,
    Modal: class {
        titleEl = document.createElement('h2');
        contentEl = document.createElement('div');
        constructor(public app: unknown) { modalInstances.push(this); }
        onClose() {}
        open() { document.body.appendChild(this.contentEl); }
        close() { this.onClose(); }
    },
}));
import { openLocalRetries, pollLocalRetries } from './local-retry-ui';
import type BijiSyncPlugin from './main';

beforeAll(() => {
    function createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
        const child = document.createElement(tag);
        if (options.text !== undefined) child.textContent = options.text;
        if (options.cls) child.className = options.cls;
        for (const [key, value] of Object.entries(options.attr || {})) child.setAttribute(key, value);
        this.appendChild(child);
        return child;
    }
    Object.assign(HTMLElement.prototype, {
        createEl,
        createDiv(this: HTMLElement, options: object = {}) { return createEl.call(this, 'div', options); },
        createSpan(this: HTMLElement, options: object = {}) { return createEl.call(this, 'span', options); },
        empty(this: HTMLElement) { this.replaceChildren(); },
        setText(this: HTMLElement, text: string) { this.textContent = text; },
    });
});

const scope = 'a'.repeat(64);

function uiFixture() {
    const files = new Map<string, string>();
    const folder = `.obsidian/clip2md/recovery/${scope}`;
    const dispatch = `${folder}/dispatch-job-7.json`;
    const monitor = `${folder}/42.json`;
    files.set(dispatch, JSON.stringify({
        taskId: 42,
        key: 'dispatch:job-7:revision',
        result: { sourceTitle: '优先展示的原文标题', markdown: 'private text', capturedAt: '2026-01-01T00:00:00Z' },
        inputId: 'input-id',
        submitted: true,
    }));
    files.set(`${dispatch}.stopped`, JSON.stringify({ reason: 'local_failed' }));
    files.set(monitor, JSON.stringify({
        taskId: 42,
        key: 'dispatch:job-7:revision',
        result: { sourceTitle: '优先展示的原文标题', markdown: 'private text' },
        inputId: 'input-id',
        submitted: true,
        error: '第一行错误\n第二行错误，必须完整保留',
    }));
    files.set(`${monitor}.status.json`, JSON.stringify({ monitorStatus: 'awaiting-local-sync' }));
    const plugin = {
        settings: { apiKey: 'test-key' },
        companion: { bindingScope: vi.fn(async () => scope) },
        isLocalRetryCurrent: (key: string) => plugin.settings.apiKey === key,
        openDesktopSettings: vi.fn(),
        app: { vault: { configDir: '.obsidian', adapter: {
            exists: async (path: string) => path === folder || files.has(path),
            list: async () => ({ files: [dispatch, monitor] }),
            read: async (path: string) => {
                if (!files.has(path)) throw new Error('missing');
                return files.get(path)!;
            },
            write: async (path: string, value: string) => { files.set(path, value); },
        } } },
    };
    return { plugin: plugin as unknown as BijiSyncPlugin, files };
}

function latestModal() {
    const modal = modalInstances.at(-1)!;
    return {
        contentEl: modal.contentEl,
        text: () => modal.contentEl.textContent || '',
        rows: () => [...modal.contentEl.querySelectorAll<HTMLElement>('.clip2md-local-retry-item')],
        button: (label: string) => [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === label)!,
        close: () => modal.close(),
    };
}

beforeEach(() => {
    request.mockReset();
    modalInstances.length = 0;
});

describe('local automatic processing records', () => {
    it('merges dispatch, monitor and stopped data into one task with cloud as current state', async () => {
        const f = uiFixture();
        request.mockResolvedValue({ status: 200, json: { items: [
            { task_id: 42, status: 'COMPLETED', reason: '', updated_at: '2020-01-01T00:00:00Z' },
            { task_id: 8, status: 'GENERATING' },
        ] } });
        await openLocalRetries(f.plugin);
        const modal = latestModal();
        expect(modal.rows()).toHaveLength(2);
        expect(modal.rows()[0].querySelector('.clip2md-local-retry-title')?.textContent).toBe('优先展示的原文标题');
        expect(modal.rows()[0].querySelector('.clip2md-local-retry-current')?.textContent).toBe('已完成');
        expect(modal.rows()[0].querySelector('.clip2md-local-retry-error')?.textContent).toContain('第一行错误\n第二行错误，必须完整保留');
        expect(modal.rows()[0].querySelectorAll('details li')).toHaveLength(2);
        expect(modal.text()).not.toContain('private text');
        expect(modal.text()).not.toContain('COMPLETED');
        expect(modal.text()).not.toContain('GENERATING');
        modal.close();
    });

    it.each([
        { response: { status: 503, json: {} }, message: 'HTTP 503' },
        { response: null, message: '无法连接云端' },
    ])('marks state unconfirmed without replacing it with a local stage: $message', async ({ response, message }) => {
        const f = uiFixture();
        if (response) request.mockResolvedValue(response);
        else request.mockRejectedValue(new Error('offline'));
        await openLocalRetries(f.plugin);
        const modal = latestModal();
        expect(modal.rows()).toHaveLength(1);
        expect(modal.rows()[0].querySelector('.clip2md-local-retry-current')?.textContent).toBe('当前状态待联网确认');
        expect(modal.text()).toContain(message);
        expect(modal.text()).toContain('第二行错误，必须完整保留');
        expect(modal.rows()[0].querySelectorAll('details li')).toHaveLength(2);
        modal.close();
    });

    it('opens desktop settings only when cloud state is waiting for source authorization', async () => {
        const f = uiFixture();
        request.mockResolvedValue({ status: 200, json: { items: [{ task_id: 42, status: 'WAITING_AUTH', reason: 'authorization_required' }] } });
        await openLocalRetries(f.plugin);
        const modal = latestModal();
        expect(modal.rows()[0].querySelector('.clip2md-local-retry-current')?.textContent).toBe('等待原站授权');
        modal.button('打开扩展设置').click();
        expect(f.plugin.openDesktopSettings).toHaveBeenCalledOnce();
        expect(modal.text()).not.toContain('手动重试');
        expect(modal.text()).not.toContain('付费');
        modal.close();
    });

    it('does not render a late cloud response after the account or binding scope changes', async () => {
        const f = uiFixture();
        let resolve!: (value: unknown) => void;
        request.mockImplementation(() => new Promise(resolvePromise => { resolve = resolvePromise; }));
        const opening = openLocalRetries(f.plugin);
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        f.plugin.settings.apiKey = 'different-account';
        vi.mocked(f.plugin.companion!.bindingScope).mockResolvedValue('b'.repeat(64));
        resolve({ status: 200, json: { items: [{ task_id: 42, status: 'COMPLETED' }] } });
        await opening;
        const modal = latestModal();
        expect(modal.rows()).toHaveLength(0);
        expect(modal.text()).not.toContain('优先展示的原文标题');
        expect(request.mock.calls[0][0].headers['X-API-Key']).toBe('test-key');
    });

    it('does not render a late response after the modal closes', async () => {
        const f = uiFixture();
        let resolve!: (value: unknown) => void;
        request.mockImplementation(() => new Promise(resolvePromise => { resolve = resolvePromise; }));
        const opening = openLocalRetries(f.plugin);
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        const modal = latestModal();
        modal.close();
        resolve({ status: 200, json: { items: [{ task_id: 42, status: 'COMPLETED' }] } });
        await opening;
        expect(modal.rows()).toHaveLength(0);
        expect(modal.contentEl.childElementCount).toBe(0);
    });

    it('reloads local files and requests cloud state again on refresh', async () => {
        const f = uiFixture();
        request.mockResolvedValue({ status: 200, json: { items: [{ task_id: 42, status: 'GENERATING' }] } });
        await openLocalRetries(f.plugin);
        const modal = latestModal();
        modal.rows()[0].querySelector('details')!.open = true;
        request.mockResolvedValue({ status: 200, json: { items: [{ task_id: 42, status: 'COMPLETED' }] } });
        modal.button('刷新').click();
        await vi.waitFor(() => expect(modal.rows()[0].querySelector('.clip2md-local-retry-current')?.textContent).toBe('已完成'));
        expect(request).toHaveBeenCalledTimes(2);
        expect(modal.rows()[0].querySelector('details')?.open).toBe(true);
        expect(modal.button('刷新').disabled).toBe(false);
        modal.close();
    });
});

function pollFixture() {
    const files = new Map<string, string>();
    const folder = `.obsidian/clip2md/recovery/${scope}`;
    const path = `${folder}/42.json`;
    files.set(path, JSON.stringify({ taskId: 42, inputId: 'input-id', submitted: true, result: { markdown: 'private text' } }));
    const plugin = {
        settings: { apiKey: 'test-key' },
        companion: { bindingScope: async () => scope },
        isLocalRetryCurrent: (key: string) => plugin.settings.apiKey === key,
        app: { vault: { configDir: '.obsidian', adapter: {
            exists: async (path: string) => path === folder || files.has(path),
            list: async () => ({ files: [path] }),
            read: async (path: string) => files.get(path)!,
            write: async (path: string, value: string) => { files.set(path, value); },
        } } },
        syncService: { markPending: vi.fn() },
        saveSettings: vi.fn(async () => {}),
        getStatusSnapshot: () => ({ runtimeState: 'idle' }),
        syncNow: vi.fn(async () => {}),
    };
    return { plugin: plugin as unknown as BijiSyncPlugin, files, path };
}

describe('accepted local submissions resume without repeating admission', () => {
    it('polls with GET, schedules AI sync once and records a small completion index', async () => {
        const { plugin, files, path } = pollFixture();
        request.mockResolvedValue({ status: 200, json: { submitted: true, current: true, status: 'SUCCESS' } });
        await pollLocalRetries(plugin); await pollLocalRetries(plugin);
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0][0].body).toBeUndefined();
        expect(plugin.syncService.markPending).toHaveBeenCalledWith(42);
        expect(plugin.syncNow).toHaveBeenCalledOnce();
        expect(files.get(path + '.status.json')).not.toContain('private text');
    });

    it('does not apply another account’s completed response', async () => {
        const { plugin } = pollFixture();
        request.mockImplementation(async () => {
            plugin.settings.apiKey = 'different';
            return { status: 200, json: { submitted: true, current: true, status: 'SUCCESS' } };
        });
        await pollLocalRetries(plugin);
        expect(plugin.syncService.markPending).not.toHaveBeenCalled();
        expect(plugin.syncNow).not.toHaveBeenCalled();
    });
});
