import { describe, expect, it } from 'vitest';
import { sanitizeConfigForBackup } from './config-backup';

describe('sanitizeConfigForBackup', () => {
    it('removes API keys while preserving non-sensitive settings', () => {
        expect(sanitizeConfigForBackup({
            apiKey: 'secret-api-key',
            targetFolder: 'Clip2MD',
            syncInterval: 60,
        })).toEqual({
            targetFolder: 'Clip2MD',
            syncInterval: 60,
        });
    });

    it('returns an empty object for invalid backup input', () => {
        expect(sanitizeConfigForBackup(null)).toEqual({});
        expect(sanitizeConfigForBackup([])).toEqual({});
    });

    it('does not copy device state or signed receipts to shared backups', () => {
        expect(sanitizeConfigForBackup({
            apiKey: 'secret',
            installationId: 'another-device',
            cursor: 'another-device-cursor',
            taskFileMap: { 9: 'note.md' },
            pendingTaskIds: [7],
            pendingAcks: [
                { taskId: 9, ackToken: 'signed-secret', imagesProcessed: 1, imagesFailed: 0 },
            ],
            targetFolder: 'Clip2MD',
        })).toEqual({ targetFolder: 'Clip2MD' });
    });
});
