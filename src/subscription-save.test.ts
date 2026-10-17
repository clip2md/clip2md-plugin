import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { archiveConfig, newSubscriptionState } from './subscriptions';
import { SyncService } from './sync';
function fixture() {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    plugin.settings = plugin['normalizeSettings']({ apiKey: 'a', subscriptionAccounts: { account: archiveConfig() } });
    plugin.syncService = new SyncService(plugin.settings);
    let stored: unknown = structuredClone(plugin.settings);
    const state = newSubscriptionState(); state.accountId = 'account';
    Object.assign(plugin, { localState: { subscriptions: state }, persistenceQueue: Promise.resolve(), subscriptionListeners: new Set(),
        writePluginState: vi.fn(async () => {}),
        legacySharedData: {}, app: { workspace: { getLeavesOfType: () => [] } },
        loadData: vi.fn(async () => structuredClone(stored)),
        saveData: vi.fn(async (value: unknown) => { stored = structuredClone(value); }),
    });
    const generation = plugin.getCredentialGeneration();
    return { plugin, state, generation, stored: () => stored };
}
describe('subscription save transactions', () => {
    it('persists a detached draft before applying rules and does not deadlock', async () => {
        const f = fixture(), config = archiveConfig({ enabled: true });
        await f.plugin.updateSubscriptionConfig(config, 'account', f.generation);
        config.enabled = false;
        expect(f.plugin.getSubscriptionConfig().enabled).toBe(true);
        expect(f.stored()).not.toHaveProperty('apiKey');
    });
    it('preserves active rules after failure and allows the next queued save', async () => {
        const f = fixture(); vi.mocked(f.plugin.saveData).mockRejectedValueOnce(new Error('disk full'));
        await expect(f.plugin.updateSubscriptionConfig(archiveConfig({ enabled: true }), 'account', f.generation)).rejects.toThrow('disk full');
        expect(f.plugin.getSubscriptionConfig().enabled).toBe(false);
        await f.plugin.updateSubscriptionConfig(archiveConfig({ enabled: true }), 'account', f.generation);
        expect(f.plugin.getSubscriptionConfig().enabled).toBe(true);
    });
    it('rejects an A-B-A credential change even if the key string matches again', async () => {
        const f = fixture();
        f.plugin.settings.apiKey = 'b'; f.plugin.getCredentialGeneration();
        f.plugin.settings.apiKey = 'a'; f.plugin.getCredentialGeneration(); f.state.unverified = false;
        await expect(f.plugin.updateSubscriptionConfig(archiveConfig({ enabled: true }), 'account', f.generation)).rejects.toThrow('凭证已变化');
        expect(f.plugin.saveData).not.toHaveBeenCalled();
    });
    it('checks identity again inside the queue and does not write an outdated draft', async () => {
        const f = fixture(); let release!: () => void;
        f.plugin['persistenceQueue'] = new Promise(resolve => { release = resolve; });
        const saved = f.plugin.updateSubscriptionConfig(archiveConfig({ enabled: true }), 'account', f.generation);
        f.plugin.settings.apiKey = 'b'; f.plugin.getCredentialGeneration(); release();
        await expect(saved).rejects.toThrow('凭证已变化'); expect(f.plugin.saveData).not.toHaveBeenCalled();
    });
    it('rolls back durable configuration if the credential changes during save', async () => {
        const f = fixture(); const save = f.plugin.saveData.bind(f.plugin);
        vi.mocked(f.plugin.saveData).mockImplementationOnce(async value => {
            await save(value); f.plugin.settings.apiKey = 'b'; f.plugin.getCredentialGeneration();
        });
        await expect(f.plugin.updateSubscriptionConfig(archiveConfig({ enabled: true }), 'account', f.generation)).rejects.toThrow('凭证已变化');
        expect(f.plugin.getSubscriptionConfig('account').enabled).toBe(false);
    });
});

it('isolates a subscription page listener exception from credential and basic settings changes', () => {
    const f = fixture(); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        f.plugin.subscribeSubscriptionChanges(() => { throw new Error('render failed'); });
        f.plugin.settings.apiKey = 'b';
        expect(() => f.plugin.getCredentialGeneration()).not.toThrow();
        expect(f.state.unverified).toBe(true);
    } finally { error.mockRestore(); }
});

it('rolls back shared and live rules if persisting the re-enabled task queue fails', async () => {
    const f = fixture(); vi.mocked(f.plugin['writePluginState']).mockRejectedValueOnce(new Error('device write failed'));
    await expect(f.plugin.updateSubscriptionConfig(archiveConfig({ enabled: true }), 'account', f.generation)).rejects.toThrow('device write failed');
    expect(f.plugin.getSubscriptionConfig().enabled).toBe(false);
});
