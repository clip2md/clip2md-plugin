import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { LOCAL_STATE_KEY, LOCAL_STATE_RECOVERY_KEY, readLocalDeviceState, saveLocalDeviceState } from './local-state';

function fixture(subscriptions: unknown) {
    const original = {
        version: 1, installationId: 'windows-vault', cursor: 'cursor-16',
        taskFileMap: { 42: 'Clip2MD/42.md' }, pendingTaskIds: [43], ignoredTaskIds: [44],
        pendingAcks: [{ taskId: 42, ackToken: 'pending-token', imagesProcessed: 0, imagesFailed: 0 }],
        restoreMissingMappedTasksOnNextSync: false, unresolvedTaskIds: [], legacyKeyMigrated: false,
        subscriptions,
    };
    const storage = new Map<string, unknown>([[LOCAL_STATE_KEY, original]]);
    const app = {
        loadLocalStorage: (key: string) => storage.get(key) ?? null,
        saveLocalStorage: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    } as unknown as App;
    return { app, storage, original };
}

describe('1.0.17 local subscription state recovery', () => {
    it.each([null, 'broken', { version: 1, statuses: {}, excludedTaskIds: [], keptLocalTaskIds: [0] }])(
        'loads core state and saves the original when subscriptions are invalid: %j', subscriptions => {
            const { app, storage, original } = fixture(subscriptions);
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const recovered = readLocalDeviceState(app)!;
                expect(recovered).toMatchObject({
                    installationId: 'windows-vault', cursor: 'cursor-16',
                    taskFileMap: { 42: 'Clip2MD/42.md' }, pendingTaskIds: [43], ignoredTaskIds: [44],
                    pendingAcks: original.pendingAcks,
                    subscriptions: { version: 1, unverified: true, excludedTaskIds: [], keptLocalTaskIds: [] },
                });
                expect(storage.get(LOCAL_STATE_RECOVERY_KEY)).toEqual(original);
                expect(storage.get(LOCAL_STATE_KEY)).toBe(original);
                saveLocalDeviceState(app, recovered);
                expect(storage.get(LOCAL_STATE_RECOVERY_KEY)).toEqual(original);
            } finally { warn.mockRestore(); }
        },
    );

    it('still stops on invalid core sync state', () => {
        const { app, storage, original } = fixture({ version: 1, statuses: {}, excludedTaskIds: [], keptLocalTaskIds: [] });
        original.pendingTaskIds = 'invalid' as unknown as number[];
        expect(() => readLocalDeviceState(app)).toThrow('本机同步状态损坏');
        expect(storage.has(LOCAL_STATE_RECOVERY_KEY)).toBe(false);
    });

    it('does not replace invalid subscription state when its recovery backup cannot be saved', () => {
        const { app, storage, original } = fixture(null);
        app.saveLocalStorage = () => undefined;
        expect(() => readLocalDeviceState(app)).toThrow('本机订阅状态备份失败');
        expect(storage.get(LOCAL_STATE_KEY)).toBe(original);
    });
});
