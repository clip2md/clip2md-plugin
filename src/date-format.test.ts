import { describe, expect, it } from 'vitest';
import { formatBeijingDateTime } from './date-format';

describe('Beijing user-facing date format', () => {
    it('formats ISO timestamps as UTC+8 without milliseconds', () => {
        expect(formatBeijingDateTime('2026-10-24T11:09:06.110Z')).toBe('2026-10-24 19:09:06');
    });
});
