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
});
