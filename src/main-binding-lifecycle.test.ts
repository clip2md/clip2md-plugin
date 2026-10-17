// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { BijiSyncSettingTab } from './settings';
import { DeviceBindingClient, DeviceBindingError } from './binding';
import { API_SECRET_ID, PENDING_SECRET_ID, type LocalDeviceState } from './local-state';
import { TimerRegistry } from './timers';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), requestUrl: request,
}));

beforeAll(() => {
    Object.assign(HTMLElement.prototype, {
        createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
            const element = document.createElement(tag);
            element.textContent = options.text || '';
            if (options.cls) element.className = options.cls;
            for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
            this.appendChild(element);
            return element;
        },
        createDiv(this: HTMLElement, options = {}) { return this.createEl('div', options); },
        empty(this: HTMLElement) { this.replaceChildren(); },
    });
});
beforeEach(() => { vi.useFakeTimers(); request.mockReset(); document.body.replaceChildren(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const session = { device_code: 'original-device-code', user_code: 'USER-CODE', expires_in: 600, interval: 5 };

function fixture() {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    const settings = plugin['normalizeSettings']({ syncInterval: 0, syncOnStart: false });
    settings.installationId = 'test-device';
    settings.apiKey = 'old-key';
    let durable: LocalDeviceState = {
        version: 1, installationId: 'test-device', cursor: null, taskFileMap: {}, pendingTaskIds: [],
        ignoredTaskIds: [], pendingAcks: [], restoreMissingMappedTasksOnNextSync: false,
        unresolvedTaskIds: [], legacyKeyMigrated: false,
    };
    let failWrites = false;
    const secrets = new Map([[API_SECRET_ID, 'old-key']]);
    const app = {
        vault: { getName: () => 'test' },
        loadLocalStorage: () => durable,
        saveLocalStorage: (_key: string, value: LocalDeviceState) => {
            // Obsidian swallows localStorage write failures; verify by reading back.
            if (!failWrites) durable = JSON.parse(JSON.stringify(value)) as LocalDeviceState;
        },
        secretStorage: {
            getSecret: (id: string) => secrets.get(id) ?? null,
            setSecret: (id: string, value: string) => { secrets.set(id, value); },
        },
    };
    Object.assign(plugin, {
        app, settings, localState: structuredClone(durable), persistenceQueue: Promise.resolve(),
        appVisible: true, bindingPollInFlight: false, bindingClient: new DeviceBindingClient(),
        timers: new TimerRegistry(),
        syncAckQueue: { snapshot: () => [] },
        getStatusSnapshot: () => ({ kind: 'configured', label: '已配置', description: '', runtimeState: 'idle' }),
        startSyncInterval: vi.fn(), startAckRetryInterval: vi.fn(),
        retryPendingAcks: vi.fn(),
    });
    const tab = new BijiSyncSettingTab(plugin.app, plugin);
    const container = document.body.createDiv();
    container.createDiv({ cls: 'clip2md-binding-region' });
    tab['activeContainerEl'] = container;
    tab.onDeviceBindingFinished = vi.fn();
    plugin['settingTab'] = tab;
    request.mockImplementation(async ({ url }: { url: string }) => ({
        status: url.includes('/sync/tasks') ? 401 : 200,
        json: url.endsWith('/start') ? session : { status: 'pending_approval', retry_after: 5 },
        arrayBuffer: new Uint8Array([1, 2]).buffer,
    }));
    return { plugin, tab, container, secrets, durable: () => durable, failWrites: (value: boolean) => { failWrites = value; } };
}

describe('binding lifecycle with real timer scheduling', () => {
    it('does not render a scannable session while the local persistence queue is still busy', async () => {
        const f = fixture();
        let release!: () => void;
        f.plugin['persistenceQueue'] = new Promise<void>(resolve => { release = resolve; });
        const starting = f.tab['startBinding']();
        await flush();
        f.tab.refresh();
        expect(f.plugin.getDeviceBindingSession()).toBeNull();
        expect(f.container.querySelector('img')).toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
        release();
        await starting;
        expect(f.container.querySelector('img')).not.toBeNull();
        expect(f.plugin.getDeviceBindingSession()?.device_code).toBe(session.device_code);
    });

    it('does not expose a QR or session after a silent local write failure, and retries from the error button', async () => {
        const f = fixture();
        f.failWrites(true);
        await f.tab['startBinding']();
        await flush();
        expect(f.plugin.getDeviceBindingSession()).toBeNull();
        expect(f.container.querySelector('img')).toBeNull();
        expect(f.container.textContent).toContain('本机同步状态保存失败');
        expect(f.container.textContent).not.toContain('等待手机端授权');
        expect(f.plugin.timers.size).toBe(0);
        expect(request.mock.calls.map(([req]) => req.url)).toHaveLength(1);

        f.failWrites(false);
        Array.from(f.container.querySelectorAll('button')).find(button => button.textContent === '重新生成')!.click();
        await flush();
        expect(f.container.querySelector('img')).not.toBeNull();
        expect(f.durable().pendingBinding?.phase).toBe('polling');
        await vi.advanceTimersByTimeAsync(5000);
        expect(request.mock.calls.some(([req]) => req.url.endsWith('/credential'))).toBe(true);
    });

    it('keeps a previous session when replacing it cannot be persisted', async () => {
        const f = fixture();
        await f.plugin.beginDeviceBinding(session);
        f.failWrites(true);
        await expect(f.plugin.beginDeviceBinding({ ...session, device_code: 'new-session' })).rejects.toThrow('保存失败');
        expect(f.plugin.getDeviceBindingSession()?.device_code).toBe(session.device_code);
        expect(f.durable().pendingBinding?.deviceCode).toBe(session.device_code);
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
    });

    it('releases the in-flight guard after timeout and ignores a response arriving after timeout', async () => {
        const f = fixture();
        let resolve!: (response: unknown) => void;
        const credential = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
            .mockResolvedValue({ status: 'pending_approval', retry_after: 5 });
        Object.assign(f.plugin, { bindingClient: { credential } });
        await f.plugin.beginDeviceBinding(session);
        await vi.advanceTimersByTimeAsync(5000);
        expect(credential).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(15000);
        expect(f.plugin['bindingPollInFlight']).toBe(false);
        resolve({ status: 'prepared', api_key: 'late-key', credential_name: 'old response' });
        await flush();
        expect(f.secrets.has(PENDING_SECRET_ID)).toBe(false);
        await vi.advanceTimersByTimeAsync(10000);
        expect(credential).toHaveBeenCalledTimes(2);
        expect(f.plugin.getDeviceBindingSession()?.device_code).toBe(session.device_code);
    });

    it('ignores an old request when a different binding session starts', async () => {
        const f = fixture();
        let resolve!: (response: unknown) => void;
        const credential = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
            .mockResolvedValue({ status: 'pending_approval', retry_after: 5 });
        Object.assign(f.plugin, { bindingClient: { credential } });
        await f.plugin.beginDeviceBinding(session);
        await vi.advanceTimersByTimeAsync(5000);
        await f.plugin.beginDeviceBinding({ ...session, device_code: 'new-session' });
        resolve({ status: 'prepared', api_key: 'stale-key', credential_name: 'old response' });
        await flush();
        expect(f.secrets.has(PENDING_SECRET_ID)).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(credential).toHaveBeenLastCalledWith('new-session');
    });

    it('bounds a hung claim by its remaining lifetime and expires without replacing the old Key', async () => {
        const f = fixture();
        const credential = vi.fn().mockImplementation(() => new Promise(() => undefined));
        Object.assign(f.plugin, { bindingClient: { credential } });
        await f.plugin.beginDeviceBinding({ ...session, expires_in: 6 });
        await vi.advanceTimersByTimeAsync(6001);
        expect(credential).toHaveBeenCalledTimes(1);
        expect(f.plugin['bindingPollInFlight']).toBe(false);
        expect(f.plugin.getDeviceBindingSession()).toBeNull();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
    });

    it('allows a fresh scan when the server reports completion but the local draft is missing', async () => {
        const f = fixture();
        Object.assign(f.plugin, { bindingClient: { credential: vi.fn().mockResolvedValue({ status: 'completed', credential_id: 8 }) } });
        await f.tab['startBinding']();
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.plugin.getDeviceBindingSession()).toBeNull();
        expect(f.plugin.getDeviceBindingMessage()).toContain('绑定结果无法恢复');
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.container.textContent).toContain('重新生成');
        await expect(f.plugin.beginDeviceBinding({ ...session, device_code: 'fresh-session' })).resolves.toBeUndefined();
    });

    it('retries terminal-state cleanup when the local write temporarily fails', async () => {
        const f = fixture();
        const credential = vi.fn().mockRejectedValue(new DeviceBindingError('denied', 403, 'access_denied'));
        Object.assign(f.plugin, { bindingClient: { credential } });
        await f.tab['startBinding']();
        f.failWrites(true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.plugin.getDeviceBindingSession()).not.toBeNull();
        expect(f.plugin.getDeviceBindingMessage()).toContain('本机同步状态保存失败');
        expect(f.plugin['bindingPollInFlight']).toBe(false);
        expect(f.plugin.timers.size).toBe(1);
        f.failWrites(false);
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.plugin.getDeviceBindingSession()).toBeNull();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.container.textContent).toContain('重新生成');
    });

    it('backs off instead of spinning when an expired session cannot be cleared locally', async () => {
        const f = fixture();
        await f.tab['startBinding']();
        f.plugin['localState'].pendingBinding!.expiresAt = Date.now() + 1000;
        f.plugin.resumeDeviceBinding();
        f.failWrites(true);
        await vi.advanceTimersByTimeAsync(10001);
        expect(f.plugin.getDeviceBindingMessage()).toContain('本机同步状态保存失败');
        expect(f.plugin.timers.size).toBe(1);
        f.failWrites(false);
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.plugin.getDeviceBindingSession()).toBeNull();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
    });

    it('recovers a timed-out complete request by probing the saved draft before replacing the active Key', async () => {
        const f = fixture();
        const credential = vi.fn().mockResolvedValue({ status: 'prepared', api_key: 'new-key', credential_name: 'Laptop' });
        const complete = vi.fn().mockImplementation(() => new Promise(() => undefined));
        const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
        Object.assign(f.plugin, { bindingClient: { credential, complete }, probeCandidateKey: probe });
        await f.plugin.beginDeviceBinding(session);
        await vi.advanceTimersByTimeAsync(5001);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.durable().pendingBinding?.phase).toBe('prepared');
        await vi.advanceTimersByTimeAsync(15000);
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.secrets.get(API_SECRET_ID)).toBe('new-key');
        expect(f.durable().pendingBinding).toBeUndefined();
        expect(complete).toHaveBeenCalledTimes(1);
    });
});
