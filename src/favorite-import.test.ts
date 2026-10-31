import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', () => ({ requestUrl: mocks.request }));
import { FavoriteLinkImporter } from './favorite-import';
import { favoriteIdentity, type FavoriteImportRequest, type FavoriteImportItemResult, type TaskContext } from './companion-protocol';
const scope = 'a'.repeat(64);
const url = (id: number) => `https://www.douyin.com/video/${7000000000000000000n + BigInt(id)}`;
const response = (status: number, json: unknown, headers = {}) => ({ status, json, headers });
const preflight = (args: { body: string }, existing: Record<string, number> = {}) => response(200, {
    matches: JSON.parse(args.body).urls.map((value: string) => ({ url: value, task_id: existing[value] ?? null })),
});
function fixture(count = 3, quota = 3) {
    let credential = 'key-a', enabled = true, continueWork = true;
    const local: TaskContext[] = [];
    const results: FavoriteImportItemResult[] = [];
    const sync = vi.fn(async () => {});
    const importer = new FavoriteLinkImporter({ credential: () => credential, scope: async () => scope, available: () => enabled, localTasks: async () => local, sync });
    const request: FavoriteImportRequest = { bindingScope: scope, platform: 'douyin',
        entries: Array.from({ length: count }, (_, i) => ({ url: url(i + 1), requestKey: `favorite-request-${i + 1}` })),
        shouldContinue: () => continueWork, onResult: async result => { results.push(result); } };
    let nextId = 100;
    mocks.request.mockImplementation(async args => args.url.endsWith('/auth/me')
        ? response(200, { daily_quota: quota, permanent_quota: 0, allowed_task_types: ['LINK'] })
        : args.url.endsWith('/links/favorites/preflight') ? preflight(args)
        : response(200, { kind: 'task', task: { id: nextId++ } }));
    return { importer, request, results, sync, local, pause: () => { continueWork = false; }, unbind: () => { credential = 'key-b'; }, disable: () => { enabled = false; } };
}
const submissions = () => mocks.request.mock.calls.map(([call]) => call).filter(call => call.url.endsWith('/links/submit'));
beforeEach(() => { mocks.request.mockReset(); });
describe('favorite work identities', () => {
    it('normalizes variants, preserves XHS access tokens and rejects profiles/collections/lookalikes', () => {
        expect(favoriteIdentity('https://www.douyin.com/user/self?modal_id=123')?.key).toBe('douyin:123');
        expect(favoriteIdentity('https://www.douyin.com/note/123')?.key).toBe('douyin:123');
        expect(favoriteIdentity('https://m.bilibili.com/video/BV1xx411c7mD?from=foo')?.url).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
        expect(favoriteIdentity('https://www.xiaohongshu.com/discovery/item/0123456789abcdef01234567?xsec_token=token')?.url).toContain('xsec_token=token');
        for (const bad of ['https://www.douyin.com/user/123', 'https://www.douyin.com/video/123?modal_id=456', 'https://www.bilibili.com/video/BV1xx411c7mD/collection', 'https://www.bilibili.com.evil.test/video/BV1xx411c7mD', 'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567', 'https://v.douyin.com/unresolved/', 'file:///video/123']) expect(favoriteIdentity(bad)).toBeUndefined();
    });
});
describe('cloud favorites submission', () => {
    it('imports more than 100 entries without an extension task limit', async () => {
        const f = fixture(137, 137); await f.importer.run(f.request);
        expect(submissions()).toHaveLength(137); expect(f.results.every(row => row.status === 'created')).toBe(true);
        expect(f.sync).toHaveBeenCalledOnce();
    });
    it('skips every request beyond the checked balance', async () => {
        const f = fixture(4, 2); await f.importer.run(f.request);
        expect(submissions()).toHaveLength(2); expect(f.results.map(row => row.status)).toEqual(['created', 'created', 'quota_skipped', 'quota_skipped']);
    });
    it('preflights candidate URLs in bounded chunks and combines local work identities', async () => {
        const f = fixture(403, 0);
        f.local.push({ taskId: 55, sourceUrl: url(1).replace('/video/', '/note/'), cloudStatus: 'success' } as TaskContext);
        const previous = mocks.request.getMockImplementation()!;
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/favorites/preflight')
            ? response(200, { matches: JSON.parse(args.body).urls.map((value: string) => ({ url: value, task_id: value === url(2) ? 200 : null })) }) : previous(args));
        await f.importer.run(f.request);
        expect(submissions()).toHaveLength(0);
        expect(f.results.slice(0, 3).map(row => row.status)).toEqual(['duplicate', 'duplicate', 'quota_skipped']);
        const sizes = mocks.request.mock.calls.map(([args]) => args).filter(args => args.url.endsWith('/links/favorites/preflight')).map(args => JSON.parse(args.body).urls.length);
        expect(sizes).toEqual([200, 200, 3]);
        expect(mocks.request.mock.calls.some(([args]) => args.url.includes('/tasks?'))).toBe(false);
    });
    it('deduplicates batch variants and does not consume the budget for server duplicates', async () => {
        const f = fixture(3, 1);
        f.request.entries[1].url = url(1).replace('/video/', '/note/');
        mocks.request.mockImplementation(async args => args.url.endsWith('/auth/me') ? response(200, { daily_quota: 1, permanent_quota: 0 })
            : args.url.endsWith('/links/favorites/preflight') ? preflight(args)
            : JSON.parse(args.body).url === url(1) ? response(409, { detail: { code: 'duplicate_link', existing_task_id: 42 } })
            : response(200, { kind: 'task', task: { id: 43 } }));
        await f.importer.run(f.request);
        expect(submissions()).toHaveLength(2); expect(f.results.map(row => row.status)).toEqual(['duplicate', 'duplicate', 'created']);
    });
    it('stops submitting after a quota race without rolling back earlier tasks', async () => {
        const f = fixture(4, 9); let sent = 0;
        const previous = mocks.request.getMockImplementation()!;
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/submit') && ++sent === 2
            ? response(403, { detail: { code: 'quota' } }) : previous(args));
        await f.importer.run(f.request);
        expect(submissions()).toHaveLength(2); expect(f.results.map(row => row.status)).toEqual(['created', 'quota_skipped', 'quota_skipped', 'quota_skipped']);
        expect(f.sync).toHaveBeenCalledWith([100]);
    });
    it.each([401, 429, 503])('pauses on HTTP %s and leaves unsent entries for resume', async status => {
        const f = fixture(); const previous = mocks.request.getMockImplementation()!;
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/submit') ? response(status, {}) : previous(args));
        expect((await f.importer.run(f.request)).stopped).toBeTruthy();
        expect(submissions()).toHaveLength(1); expect(f.results).toHaveLength(1); expect(f.results[0].status).toBe('failed');
    });
    it('never proceeds when quota or duplicate preflight is unavailable', async () => {
        const f = fixture(); mocks.request.mockResolvedValue(response(503, {}));
        await expect(f.importer.run(f.request)).rejects.toThrow('额度查询失败'); expect(submissions()).toHaveLength(0);
        mocks.request.mockResolvedValue(response(200, { daily_quota: 3, permanent_quota: 0 }));
        await expect(f.importer.run(f.request)).rejects.toThrow('重复预检格式无效'); expect(submissions()).toHaveLength(0);
    });
    it('persists each result before the next request and syncs even when cancelled', async () => {
        const f = fixture(); f.request.onResult = async result => { f.results.push(result); f.pause(); };
        const result = await f.importer.run(f.request);
        expect(result.stopped).toBeTruthy(); expect(submissions()).toHaveLength(1); expect(f.sync).toHaveBeenCalledWith([100]);
    });
    it('does not send later requests or sync under a switched binding', async () => {
        const f = fixture(); f.request.onResult = async result => { f.results.push(result); f.unbind(); };
        await f.importer.run(f.request); expect(submissions()).toHaveLength(1); expect(f.sync).not.toHaveBeenCalled();
    });
    it('rejects profile links before invoking unified ingress and keeps operation keys stable', async () => {
        const f = fixture(2, 2); f.request.entries[0].url = 'https://www.douyin.com/user/self';
        await f.importer.run(f.request); expect(f.results[0].status).toBe('invalid'); expect(submissions()).toHaveLength(1);
        const idempotency = submissions()[0].headers['Idempotency-Key'];
        await f.importer.run({ ...f.request, entries: [f.request.entries[1]] });
        expect(submissions().at(-1).headers['Idempotency-Key']).toBe(idempotency);
    });
    it('serializes concurrent batch attempts even during asynchronous binding checks', async () => {
        const f = fixture();
        const first = f.importer.run(f.request);
        await expect(f.importer.run(f.request)).rejects.toThrow('已有收藏导入');
        await first;
        expect(submissions()).toHaveLength(3);
    });
    it('stops if checkpointing fails, while still syncing a task already accepted', async () => {
        const f = fixture(); f.request.onResult = async () => { throw new Error('disk full'); };
        await expect(f.importer.run(f.request)).rejects.toThrow('disk full'); expect(submissions()).toHaveLength(1); expect(f.sync).toHaveBeenCalledWith([100]);
    });    it('recovers an unknown submission through preflight at zero balance and syncs the existing task', async () => {
        const f = fixture(1, 1), previous = mocks.request.getMockImplementation()!;
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/submit') ? Promise.reject(new Error('lost response')) : previous(args));
        await f.importer.run(f.request);
        expect(f.results[0]).toMatchObject({ status: 'failed', uncertain: true });
        f.request.entries[0].reconcile = true;
        mocks.request.mockImplementation(async args => args.url.endsWith('/auth/me') ? response(200, { daily_quota: 0, permanent_quota: 0 })
            : response(200, { matches: [{ url: url(1), task_id: 42 }] }));
        await f.importer.run(f.request);
        expect(f.results.at(-1)).toMatchObject({ status: 'duplicate', syncPending: true, taskId: 42 });
        expect(submissions()).toHaveLength(1); expect(f.sync).toHaveBeenCalledWith([42]);
    });
    it('syncs durable accepted receipts even when no entries remain to submit', async () => {
        const f = fixture(0, 0);
        await f.importer.run({ ...f.request, acceptedTaskIds: [42] });
        expect(f.sync).toHaveBeenCalledWith([42]); expect(submissions()).toHaveLength(0);
    });
    it('journals uncertain state before a paid request and stops if that write fails', async () => {
        const f = fixture();
        f.request.onSubmitting = vi.fn(async () => { throw new Error('disk full'); });
        await expect(f.importer.run(f.request)).rejects.toThrow('disk full'); expect(submissions()).toHaveLength(0);
    });
    it('does not spend budget on a replayed successful request', async () => {
        const f = fixture(2, 1), previous = mocks.request.getMockImplementation()!;
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/submit') && JSON.parse(args.body).url === url(1)
            ? response(200, { kind: 'task', task: { id: 42, duplicate: true, replayed: true } }) : previous(args));
        await f.importer.run(f.request);
        expect(f.results.map(row => row.status)).toEqual(['duplicate', 'created']);
        expect(f.sync).toHaveBeenCalledWith([100]);
    });
    it('fails closed for unavailable or mismatched preflight responses', async () => {
        const f = fixture(), previous = mocks.request.getMockImplementation()!;
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/favorites/preflight') ? response(404, {}) : previous(args));
        await expect(f.importer.run(f.request)).rejects.toThrow('更新服务端'); expect(submissions()).toHaveLength(0);
        mocks.request.mockImplementation(async args => args.url.endsWith('/links/favorites/preflight') ? response(200, { matches: [1, 2, 3].map(() => ({ url: url(1), task_id: null })) }) : previous(args));
        await expect(f.importer.run(f.request)).rejects.toThrow('格式无效'); expect(submissions()).toHaveLength(0);
    });

});
