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

    it('does not copy signed receipts to backups and keeps their tasks retryable', () => {
        expect(sanitizeConfigForBackup({
            apiKey: 'secret',
            pendingTaskIds: [7],
            pendingAcks: [
                { taskId: 9, ackToken: 'signed-secret', imagesProcessed: 1, imagesFailed: 0 },
                { taskId: 9, ackToken: 'signed-secret', imagesProcessed: 1, imagesFailed: 0 },
            ],
        })).toEqual({ pendingTaskIds: [7, 9] });
    });
});
