import { describe, expect, it, vi } from 'vitest';
import { isArchiveSnapshot, isBloggerInfo, isCloudWork, isCloudReport, isSubscriptionContext, fetchArchiveSnapshot, ArchiveRequestError } from './subscriptions';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', async original => ({ ...await original<Record<string, unknown>>(), requestUrl: request }));
const blogger = { id: 1, platform: 'youtube', blogger_id: 'UC-test', name: null, homepage: 'https://youtube.com/@test', profile: {}, ends_at: '2026-11-01',
    last_scan: { status: 'FUTURE', scheduled_at: '2026-10-17', completed_at: null, error_code: null, new_work_count: 0 } };
const work = { id: 1, subscription_id: 1, work_id: 'abc', platform: 'youtube', url: 'https://youtube.com/watch?v=abc', metadata: {}, baseline: false,
    first_discovered_at: '2026-10-17', task_id: null, clip_status: 'FUTURE', clip_outcome: null, comment_status: null, supplement_task_id: null };
const report = { date: '2026-10-17', generated_at: '2026-10-17T01:00:00Z', task_id: null, status: null };
describe('subscription boundary validation', () => {
    it('accepts server nulls, future statuses and additional fields', () => {
        expect(isBloggerInfo({ ...blogger, future: true })).toBe(true);
        expect(isCloudWork(work)).toBe(true); expect(isCloudReport(report)).toBe(true);
        expect(isArchiveSnapshot({ account_id: 'a', features: {}, items: [blogger], works: [work], reports: [report], fetchedAt: 'now' })).toBe(true);
    });
    it.each([null, [], { ...blogger, id: 0 }, { ...blogger, profile: [] }, { ...blogger, last_scan: { ...blogger.last_scan, new_work_count: -1 } }])('rejects malformed bloggers: %j', value => {
        expect(isBloggerInfo(value)).toBe(false);
    });
    it('rejects malformed work, report and nested document identities', () => {
        expect(isCloudWork({ ...work, task_id: -1 })).toBe(false);
        expect(isCloudReport({ ...report, date: 'not-a-date' })).toBe(false);
        expect(isSubscriptionContext({ kind: 'daily_report', account_id: 'a', report_date: '2026-10-17', related_works: [null] })).toBe(false);
    });
    it('validates every page before returning a snapshot', async () => {
        request.mockReset();
        request.mockImplementation(async ({ url }: { url: string }) => ({ status: 200, json: url.endsWith('/bloggers') ? { account_id: 'a', features: {}, items: [blogger] }
            : url.includes('/works') ? { total: 2, items: url.includes('page=1&') ? [work] : [{ ...work, id: 'invalid' }] } : { total: 0, items: [] } }));
        await expect(fetchArchiveSnapshot('key')).rejects.toThrow('分页格式');
    });
    it('distinguishes authentication and incompatible server errors', () => {
        expect(new ArchiveRequestError(401).kind).toBe('authentication');
        expect(new ArchiveRequestError(404).kind).toBe('unsupported');
        expect(new ArchiveRequestError(500).kind).toBe('server');
    });
});
