import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { API_SECRET_ID, PENDING_SECRET_ID, type LocalDeviceState } from './local-state';
import { DEFAULT_FRONTMATTER_TEMPLATE, type BijiSyncSettings } from './settings';

function fixture() {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    const settings: BijiSyncSettings = {
        apiKey: 'old-key', installationId: 'laptop', settingsSchemaVersion: 3,
        syncInterval: 0, syncOnStart: false, preventReimportAfterLocalRemoval: false,
        targetFolder: 'Clip2MD', filenameTemplate: '{{title}}', filenameDateFormat: 'yyyy-MM-dd',
        template: '{{content}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
        syncContentMode: 'full', imageMode: 'local', imageFolder: '', mergeMode: 'none',
    };
    const state: LocalDeviceState = {
        version: 1, installationId: 'laptop', cursor: null, taskFileMap: {}, pendingTaskIds: [],
        ignoredTaskIds: [], pendingAcks: [], restoreMissingMappedTasksOnNextSync: false,
        unresolvedTaskIds: [], legacyKeyMigrated: false,
    };
    const secrets = new Map([[API_SECRET_ID, 'old-key']]);
    let durable: LocalDeviceState | null = null;
    let failNextSave = false;
    const credential = vi.fn(async () => ({ status: 'prepared', api_key: 'new-key', credential_name: 'Laptop' }));
    const complete = vi.fn(async () => ({ status: 'completed', credential_id: 8, credential_name: 'Laptop' }));
    const probe = vi.fn(async () => false);
    Object.assign(plugin, {
        settings, localState: state, appVisible: true, bindingPollInFlight: false,
        connectionState: 'configured', persistenceQueue: Promise.resolve(),
        app: {
            loadLocalStorage: () => durable,
            saveLocalStorage: (_key: string, value: LocalDeviceState) => {
                if (failNextSave) { failNextSave = false; throw new Error('storage full'); }
                durable = structuredClone(value);
            },
            secretStorage: {
                getSecret: (id: string) => secrets.get(id) ?? null,
                setSecret: (id: string, value: string) => { secrets.set(id, value); },
            },
        },
        syncService: {
            getCursor: () => null, getTaskFileMap: () => ({}), getPendingTaskIds: () => [],
            getIgnoredTaskIds: () => [],
        },
        syncAckQueue: { snapshot: () => [] },
        bindingClient: { credential, complete },
        timers: { clearTimeout: vi.fn(), setTimeout: vi.fn(() => 1), clearInterval: vi.fn() },
        probeCandidateKey: probe,
        startSyncInterval: vi.fn(), startAckRetryInterval: vi.fn(), refreshSettingTab: vi.fn(),
        settingTab: null,
    });
    return { plugin, secrets, credential, complete, probe, durable: () => durable, failNextSave: () => { failNextSave = true; } };
}

describe('v2 plugin binding', () => {
    it('stores the invalid-Key flag locally while retaining the original Key', async () => {
        const f = fixture();
        f.plugin['updateConnectionState']('invalid', 'HTTP 401');
        await f.plugin['persistenceQueue'];
        expect(f.durable()?.credentialInvalid).toBe(true);
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.plugin.getStatusSnapshot().kind).toBe('invalid');
    });

    it('persists the candidate before complete and preserves the old Key until completion', async () => {
        const f = fixture();
        await f.plugin.beginDeviceBinding({ device_code: 'device-code', user_code: 'USER-CODE', expires_in: 600, interval: 5 });
        await f.plugin['pollDeviceBinding']();
        expect(f.credential).toHaveBeenCalledTimes(1);
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.secrets.get(PENDING_SECRET_ID)).toBe('new-key');
        expect(f.durable()?.pendingBinding?.phase).toBe('prepared');

        await f.plugin['pollDeviceBinding']();
        expect(f.complete).toHaveBeenCalledWith('device-code', 'new-key');
        expect(f.secrets.get(API_SECRET_ID)).toBe('new-key');
        expect(f.plugin.settings.credentialId).toBe(8);
        expect(f.durable()?.pendingBinding).toBeUndefined();
    });

    it('keeps the old Key when the approval expires before a candidate is claimed', async () => {
        const f = fixture();
        await f.plugin.beginDeviceBinding({ device_code: 'device-code', user_code: 'USER-CODE', expires_in: 600, interval: 5 });
        f.plugin['localState'].pendingBinding!.expiresAt = Date.now() - 1;
        await f.plugin['pollDeviceBinding']();
        expect(f.credential).not.toHaveBeenCalled();
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.durable()?.pendingBinding).toBeUndefined();
    });

    it('does not complete when the prepared draft cannot be persisted', async () => {
        const f = fixture();
        await f.plugin.beginDeviceBinding({ device_code: 'device-code', user_code: 'USER-CODE', expires_in: 600, interval: 5 });
        f.failNextSave();
        await f.plugin['pollDeviceBinding']();
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.durable()?.pendingBinding?.phase).toBe('polling');
    });

    it('recovers a lost complete response by probing the saved candidate', async () => {
        const f = fixture();
        await f.plugin.beginDeviceBinding({ device_code: 'device-code', user_code: 'USER-CODE', expires_in: 600, interval: 5 });
        await f.plugin['pollDeviceBinding']();
        f.complete.mockRejectedValueOnce(new Error('response lost'));
        await f.plugin['pollDeviceBinding']();
        expect(f.secrets.get(API_SECRET_ID)).toBe('old-key');
        expect(f.durable()?.pendingBinding?.phase).toBe('prepared');
        f.probe.mockResolvedValueOnce(true);
        await f.plugin['pollDeviceBinding']();
        expect(f.secrets.get(API_SECRET_ID)).toBe('new-key');
        expect(f.complete).toHaveBeenCalledTimes(1);
        expect(f.durable()?.pendingBinding).toBeUndefined();
    });
});
