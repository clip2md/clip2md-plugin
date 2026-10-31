import { describe, expect, it } from 'vitest';
import { subscriptionCloudFilter, subscriptionPresentation } from './subscription-presentation';

const present = (cloud: string | null, local: string, baseline = false, localOnly = false) =>
    subscriptionPresentation({ cloud, local, baseline, localOnly });

describe('subscription work presentation', () => {
    it.each([
        ['SUCCESS', 'cloud-success'], ['PENDING', 'cloud-pending'], ['PROCESSING', 'cloud-pending'],
        ['WAITING_SERVICE', 'cloud-pending'], ['FAILED', 'cloud-failed'], ['FAILED_SERVICE_UNAVAILABLE', 'cloud-failed'],
        [null, 'cloud-none'], ['UNKNOWN', 'cloud-unknown'],
    ] as const)('maps %s to one cloud filter', (cloud, expected) => {
        expect(subscriptionCloudFilter(cloud)).toBe(expected);
    });
    it.each([
        ['conflict', '批注冲突'], ['images', '图片处理失败'], ['error', '本地同步失败'],
    ])('prioritizes local errors over cloud completion', (local, label) => {
        expect(present('SUCCESS', local)).toMatchObject({ label, needsAttention: true, tone: 'error' });
    });
    it('includes pending and failed work in the actionable view', () => {
        expect(present(null, '', false)).toMatchObject({ label: '待剪藏', needsAttention: true });
        expect(present('PENDING', 'pending')).toMatchObject({ label: '云端处理中', needsAttention: true });
        expect(present('SUCCESS', 'pending')).toMatchObject({ label: '待同步', needsAttention: true });
        expect(present('FAILED', 'pending')).toMatchObject({ label: '云端失败', needsAttention: true });
    });
    it('excludes historical, complete and excluded work by default', () => {
        expect(present(null, '', true).needsAttention).toBe(false);
        expect(present('SUCCESS', 'synced').needsAttention).toBe(false);
        expect(present('FAILED', 'excluded').needsAttention).toBe(false);
        expect(present('SUCCESS', 'synced', false, true)).toMatchObject({ label: '本地已保存', needsAttention: false });
    });
});
