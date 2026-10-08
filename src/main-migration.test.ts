import { describe, expect, it } from 'vitest';
import BijiSyncPlugin from './main';

function migrate(files: Record<string, string>, legacy: Record<string, unknown>, localKey?: string) {
    const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    plugin.settings = plugin['normalizeSettings'](legacy);
    let stored: unknown = null;
    const secrets = new Map<string, string>();
    if (localKey) secrets.set('clip2md-api-key', localKey);
    Object.assign(plugin, {
        app: {
            vault: {
                getMarkdownFiles: () => Object.keys(files).map(path => ({ path })),
                getFileByPath: (path: string) => Object.hasOwn(files, path) ? { path } : null,
                read: async (file: { path: string }) => files[file.path],
            },
            loadLocalStorage: () => stored,
            saveLocalStorage: (_key: string, value: unknown) => { stored = structuredClone(value); },
            secretStorage: {
                getSecret: (id: string) => secrets.get(id) ?? null,
                setSecret: (id: string, value: string) => { secrets.set(id, value); },
            },
        },
    });
    return plugin['loadOrMigrateLocalState'](legacy).then(state => ({ state, secrets }));
}

describe('legacy shared data migration', () => {
    it('rescans this Vault and pauses ambiguous missing notes before any receipt', async () => {
        const { state, secrets } = await migrate({ 'moved/43.md': '---\ntask_id: 43\n---\n' }, {
            apiKey: 'old-shared-key', cursor: 'other-device-cursor',
            taskFileMap: { 42: 'other-device/42.md', 43: 'old/43.md' },
            ignoredTaskIds: [44], pendingAcks: [{ taskId: 42, ackToken: 'old-receipt' }],
            preventReimportAfterLocalRemoval: true,
        });
        expect(state.cursor).toBeNull();
        expect(state.taskFileMap).toEqual({ 43: 'moved/43.md' });
        expect(state.unresolvedTaskIds).toEqual([42, 44]);
        expect(state.pendingAcks).toEqual([]);
        expect(secrets.get('clip2md-api-key')).toBe('old-shared-key');
    });

    it('recognizes a moved daily note by its task marker', async () => {
        const { state } = await migrate({ 'daily/notes.md': '<!-- clip2md-task-start:42 -->\n正文\n<!-- clip2md-task-end:42 -->' }, {
            taskFileMap: { 42: 'old/42.md' }, preventReimportAfterLocalRemoval: true,
        });
        expect(state.taskFileMap[42]).toBe('daily/notes.md');
        expect(state.unresolvedTaskIds).toEqual([]);
    });

    it('keeps a Key already stored on this device when legacy data.json arrives later', async () => {
        const { state, secrets } = await migrate({}, { apiKey: 'shared-old-key' }, 'local-new-key');
        expect(secrets.get('clip2md-api-key')).toBe('local-new-key');
        expect(state.legacyKeyMigrated).toBe(false);
    });
});
