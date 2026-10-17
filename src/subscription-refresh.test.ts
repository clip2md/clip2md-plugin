import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { newSubscriptionState } from './subscriptions';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', async original => ({ ...await original<Record<string, unknown>>(), requestUrl: request }));
function fixture() {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    const state = newSubscriptionState(); state.accountId = 'account-a';
    state.snapshot = { account_id: 'account-a', features: {}, items: [], works: [], reports: [], fetchedAt: 'prior' };
    Object.assign(plugin, { settings: { apiKey: 'a' }, localState: { subscriptions: state }, subscriptionNotes: [],
        subscriptionListeners: new Set(), subscriptionError: '', subscriptionErrorKind: null,
        app: { workspace: { getLeavesOfType: () => [] } },
        syncService: { setCursor: vi.fn(), loadTaskFileMap: vi.fn(), loadPendingTaskIds: vi.fn(), loadIgnoredTaskIds: vi.fn() },
        syncAckQueue: { load: vi.fn() }, configureSubscriptionRouting: vi.fn(async () => {}), persistSyncState: vi.fn(async () => {}),
        updateConnectionState: vi.fn(),
    });
    plugin.getCredentialGeneration(); request.mockReset();
    return { plugin, state };
}
function listing(account_id: string) { return { status: 200, json: { account_id, features: {}, items: [] } }; }
const emptyPage = { status: 200, json: { items: [], total: 0 } };
describe('subscription request identity isolation', () => {
    it('ignores an old authentication failure after a new account has loaded', async () => {
        const { plugin } = fixture(); let finishA!: (value: unknown) => void;
        request.mockImplementation(async ({ url, headers }) => {
            if (!url.endsWith('/bloggers')) return emptyPage;
            if (headers['X-API-Key'] === 'a') return new Promise(resolve => { finishA = resolve; });
            return listing('account-b');
        });
        const a = plugin.refreshSubscriptionSnapshot();
        plugin.settings.apiKey = 'b'; plugin.getCredentialGeneration();
        await plugin.refreshSubscriptionSnapshot();
        finishA({ status: 401 }); await a;
        expect(plugin.getSubscriptionState().accountId).toBe('account-b');
        expect(plugin.getSubscriptionState().unverified).toBe(false);
        expect(plugin.subscriptionErrorKind).toBeNull(); expect(plugin.subscriptionLoading).toBe(false);
    });
    it('ignores an A-B-A response despite identical key text', async () => {
        const { plugin } = fixture(); let finish!: (value: unknown) => void;
        request.mockImplementation(async ({ url }) => url.endsWith('/bloggers') ? new Promise(resolve => { finish = resolve; }) : emptyPage);
        const old = plugin.refreshSubscriptionSnapshot();
        plugin.settings.apiKey = 'b'; plugin.getCredentialGeneration();
        plugin.settings.apiKey = 'a'; plugin.getCredentialGeneration();
        finish(listing('account-a')); await old;
        expect(plugin.getSubscriptionState().snapshot?.fetchedAt).toBe('prior');
        expect(plugin.getSubscriptionState().unverified).toBe(true); expect(plugin.persistSyncState).not.toHaveBeenCalled();
    });
    it('retains a prior valid snapshot on malformed pages and distinguishes authentication failures', async () => {
        const { plugin, state } = fixture();
        request.mockImplementation(async ({ url }) => url.endsWith('/bloggers') ? listing('account-a') : { status: 200, json: { total: -1, items: [] } });
        await plugin.refreshSubscriptionSnapshot();
        expect(state.snapshot?.fetchedAt).toBe('prior'); expect(plugin.subscriptionErrorKind).toBe('format');
        expect(state.unverified).not.toBe(true);
        request.mockResolvedValue({ status: 401 }); await plugin.refreshSubscriptionSnapshot();
        expect(plugin.subscriptionErrorKind).toBe('authentication'); expect(state.unverified).toBe(true);
    });
});
