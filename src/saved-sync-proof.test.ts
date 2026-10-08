import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { resolveImagePath, savedTaskContent, sha256, verifySavedSyncProof } from './saved-sync-proof';

describe('durable Vault write proof', () => {
    beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });

    it('resolves encoded attachment paths without escaping the Vault', () => {
        expect(resolveImagePath('Notes/task.md', '../附件%20图片/图.png')).toBe('附件 图片/图.png');
        expect(resolveImagePath('Notes/task.md', '<../附件 图片/图.png>')).toBe('附件 图片/图.png');
        expect(resolveImagePath('Notes/task.md', '../../outside.png')).toBeNull();
        expect(resolveImagePath('Notes/task.md', 'https://example.test/a.png')).toBeNull();
        expect(resolveImagePath('Notes/task.md', '%zz')).toBeNull();
    });

    it('checks only the current daily task block but checks its attachment bytes', async () => {
        const block = '<!-- clip2md-task-start:42 -->\nbody ![a](./a.png)\n<!-- clip2md-task-end:42 -->';
        let content = `${block}\nother task`;
        let bytes = new Uint8Array([1, 2, 3]).buffer;
        const file = (path: string) => Object.assign(new TFile(), { path });
        const vault = { getAbstractFileByPath: (path: string) => file(path), read: async () => content, readBinary: async () => bytes };
        const proof = { filepath: 'Notes/daily.md', contentHash: await sha256(block), images: [{ path: 'Notes/a.png', hash: await sha256(bytes) }] };
        expect(await verifySavedSyncProof(vault as never, 42, proof)).toBe(true);
        content = `${block}\nchanged other task`;
        expect(await verifySavedSyncProof(vault as never, 42, proof)).toBe(true);
        bytes = new Uint8Array([3, 2, 1]).buffer;
        expect(await verifySavedSyncProof(vault as never, 42, proof)).toBe(false);
        content = 'task removed';
        expect(await verifySavedSyncProof(vault as never, 42, proof)).toBe(false);
        expect(savedTaskContent('<!-- clip2md-task-start:43 -->other<!-- clip2md-task-end:43 -->', 42)).toBe('');
    });
});
