import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSyncAck, getSyncAckBlockedReason, parsePendingSyncAcks, postSyncAck, SyncAckHttpError, SyncAckQueue, type PendingSyncAck } from './sync-ack';
import type { SyncTask } from './sync';

const requestUrlMock = vi.hoisted(() => vi.fn());
vi.mock('obsidian', () => ({ requestUrl: requestUrlMock }));

const receipt: PendingSyncAck = {
    taskId: 42,
    ackToken: 'signed-token',
    imagesProcessed: 1,
    imagesFailed: 0,
};

const task = {
    id: 42,
    status: 'SUCCESS',
    ack_token: 'signed-token',
    asset_count: 1,
    asset_ready_count: 1,
    asset_pending_count: 0,
    asset_failed_count: 0,
} as SyncTask;
const fullSettings = { imageMode: 'local', syncContentMode: 'full', template: '{{content}}' } as const;

describe('Obsidian sync receipts', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        requestUrlMock.mockReset();
    });

    it('accepts only a completed Vault write with every server asset localized', () => {
        const complete = { filepath: 'Clippings/task.md', skipped: false, localizedAssetCount: 1 };
        expect(buildSyncAck(task, complete, fullSettings)).toEqual(receipt);
        expect(buildSyncAck({ ...task, asset_count: 0, asset_ready_count: 0 }, {
            filepath: 'Clippings/text.md', skipped: false, localizedAssetCount: 0,
        }, { ...fullSettings, imageMode: 'disabled' })).toEqual({ ...receipt, imagesProcessed: 0 });
        expect(buildSyncAck(task, complete, { ...fullSettings, imageMode: 'disabled' })).toBeNull();
        expect(buildSyncAck(task, complete, { ...fullSettings, syncContentMode: 'note' })).toBeNull();
        expect(buildSyncAck(task, complete, { ...fullSettings, syncContentMode: 'source' })).toBeNull();
        expect(buildSyncAck(task, complete, { ...fullSettings, template: '{{title}}' })).toBeNull();
        expect(buildSyncAck(task, { ...complete, localizedAssetCount: 0 }, fullSettings)).toBeNull();
        expect(buildSyncAck(task, { ...complete, failedAssets: true }, fullSettings)).toBeNull();
        expect(buildSyncAck(task, { ...complete, pendingAssets: true }, fullSettings)).toBeNull();
        expect(buildSyncAck(task, { ...complete, unlocalizedImages: true }, fullSettings)).toBeNull();
        expect(buildSyncAck({ ...task, asset_pending_count: 1 }, complete, fullSettings)).toBeNull();
        expect(buildSyncAck({ ...task, asset_failed_count: 1 }, complete, fullSettings)).toBeNull();
        expect(buildSyncAck({ ...task, ack_token: null }, complete, fullSettings)).toBeNull();
        expect(buildSyncAck(task, { ...complete, skipped: true }, fullSettings)).toBeNull();
    });

    it('persists and posts v2 scope without losing the local readback proof', async () => {
        const scoped = {
            ...task, ack_scope: { version: 2 as const, content_mode: 'source' as const,
                required_assets: [{ id: 7, url: '/api/v1/assets/7', status: 'READY' }] },
        };
        const result = { filepath: 'Clippings/task.md', skipped: false, selectedContentWritten: true,
            verifiedAssetIds: [7], imageErrors: [], savedProof: { filepath: 'Clippings/task.md', contentHash: 'hash',
                images: [{ path: '附件/a.png', hash: 'image-hash' }] } };
        const settings = { ...fullSettings, syncContentMode: 'source' as const };
        expect(buildSyncAck(scoped, result, settings)).toBeNull();
        const ack = buildSyncAck(scoped, result, settings, true)!;
        expect(parsePendingSyncAcks([JSON.parse(JSON.stringify(ack))])).toEqual([ack]);
        expect(parsePendingSyncAcks([{ ...ack, savedProof: null }, { ...ack, subsetConfirmed: false }])).toEqual([]);
        expect(buildSyncAck(scoped, result, fullSettings, true)).toBeNull();
        requestUrlMock.mockResolvedValue({ status: 200 });
        await postSyncAck(ack, 'key');
        expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toEqual({
            ack_token: 'signed-token', vault_write_ok: true, images_processed: 1, images_failed: 0,
            scope_version: 2, content_mode: 'source', processed_asset_ids: [7], subset_confirmed: true,
            image_mode: 'local', images_omitted_confirmed: false,
        });
    });

    it('persists the explicit image omission scope and rejects an unconfirmed stored receipt', async () => {
        const scoped = { ...task, ack_scope: { version: 2 as const, content_mode: 'full' as const, image_mode: 'disabled' as const, required_assets: [] } };
        const settings = { ...fullSettings, imageMode: 'disabled' as const };
        const result = { filepath: 'Clippings/task.md', skipped: false, selectedContentWritten: true, imagesOmitted: true,
            verifiedAssetIds: [], imageErrors: [], savedProof: { filepath: 'Clippings/task.md', contentHash: 'hash', images: [] } };
        const ack = buildSyncAck(scoped, result, settings, true)!;
        expect(parsePendingSyncAcks([ack])).toEqual([ack]);
        expect(parsePendingSyncAcks([{ ...ack, imagesOmittedConfirmed: false }])).toEqual([]);
        requestUrlMock.mockResolvedValue({ status: 200 });
        await postSyncAck(ack, 'key');
        expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toMatchObject({
            image_mode: 'disabled', images_omitted_confirmed: true, images_processed: 0, processed_asset_ids: [],
        });
    });

    it('posts only a receipt and treats stale, missing or invalid tokens as terminal', async () => {
        requestUrlMock.mockResolvedValueOnce({ status: 200 })
            .mockResolvedValueOnce({ status: 404 })
            .mockResolvedValueOnce({ status: 409 })
            .mockResolvedValueOnce({ status: 400 })
            .mockResolvedValueOnce({ status: 422 })
            .mockResolvedValueOnce({ status: 503 });

        await expect(postSyncAck(receipt, 'api-key')).resolves.toBe('accepted');
        expect(requestUrlMock).toHaveBeenCalledWith({
            url: 'https://api.clip2md.cn/api/v1/sync/tasks/42/ack',
            method: 'POST',
            headers: { 'X-API-Key': 'api-key', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ack_token: 'signed-token', vault_write_ok: true,
                images_processed: 1, images_failed: 0,
            }),
            throw: false,
        });
        await expect(postSyncAck(receipt, 'api-key')).resolves.toBe('discard');
        await expect(postSyncAck(receipt, 'api-key')).resolves.toBe('discard');
        await expect(postSyncAck(receipt, 'api-key')).resolves.toBe('discard');
        await expect(postSyncAck(receipt, 'api-key')).resolves.toBe('discard');
        await expect(postSyncAck(receipt, 'api-key')).rejects.toThrow('HTTP 503');
    });

    it('reports a revoked Key separately so the plugin can pause receipt retries', async () => {
        requestUrlMock.mockResolvedValueOnce({ status: 401 });
        await expect(postSyncAck(receipt, 'revoked-key')).rejects.toMatchObject({
            name: SyncAckHttpError.name, status: 401,
        });
    });

    it('explains local write, content settings and image failures without warning when deletion is disabled', () => {
        const complete = { filepath: 'Clippings/task.md', skipped: false, localizedAssetCount: 1 };
        expect(getSyncAckBlockedReason(task, complete, fullSettings)).toBeNull();
        expect(getSyncAckBlockedReason(task, { ...complete, filepath: null }, fullSettings)).toBe('Vault 文件未写入');
        expect(getSyncAckBlockedReason(task, { ...complete, skipped: true }, fullSettings)).toBe('Vault 文件未写入');
        expect(getSyncAckBlockedReason(task, complete, { ...fullSettings, syncContentMode: 'note' })).toBe('同步内容未选择“完整内容”');
        expect(getSyncAckBlockedReason(task, complete, { ...fullSettings, template: '{{note_content}}' })).toBe('模板未包含完整正文 {{content}}');
        expect(getSyncAckBlockedReason(task, complete, { ...fullSettings, imageMode: 'disabled' })).toBe('图片未设置为本地保存');
        expect(getSyncAckBlockedReason(task, { ...complete, failedAssets: true }, fullSettings)).toBe('部分图片保存失败');
        expect(getSyncAckBlockedReason(task, { ...complete, pendingAssets: true }, fullSettings)).toBe('图片仍在处理中');
        expect(getSyncAckBlockedReason(task, { ...complete, unlocalizedImages: true }, fullSettings)).toBe('部分图片未保存到 Vault');
        expect(getSyncAckBlockedReason(task, { ...complete, localizedAssetCount: 0 }, fullSettings)).toBe('部分图片未保存到 Vault');
        expect(getSyncAckBlockedReason({ ...task, ack_token: null }, { ...complete, failedAssets: true }, fullSettings)).toBeNull();
        expect(getSyncAckBlockedReason({ ...task, status: 'PROCESSING' }, complete, fullSettings)).toBeNull();
    });

    it('saves before sending, retains a network-failed receipt, and retries after restart', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let durable: PendingSyncAck[] = [];
        let online = false;
        let queue: SyncAckQueue;
        const deliver = vi.fn(async () => {
            expect(durable).toEqual([receipt]);
            if (!online) throw new Error('offline');
            return 'accepted' as const;
        });
        queue = new SyncAckQueue(async () => { durable = queue.snapshot(); }, deliver);

        await queue.enqueue(receipt);
        await queue.flush();
        expect(durable).toEqual([receipt]);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledTimes(1);

        online = true;
        const restarted = new SyncAckQueue(async () => { durable = restarted.snapshot(); }, deliver);
        restarted.load(durable);
        await restarted.flush();
        expect(durable).toEqual([]);
        expect(deliver).toHaveBeenCalledTimes(2);
    });

    it('rejects malformed stored receipts and keeps the latest token per task', () => {
        expect(parsePendingSyncAcks([
            { ...receipt, ackToken: 'old' },
            { ...receipt },
            { ...receipt, taskId: 0 },
            { ...receipt, imagesProcessed: -1 },
            { ...receipt, ackToken: '' },
        ])).toEqual([receipt]);
    });

    it('never sends when the receipt cannot be saved', async () => {
        const deliver = vi.fn(async () => 'accepted' as const);
        const queue = new SyncAckQueue(async () => { throw new Error('disk full'); }, deliver);

        await expect(queue.enqueue(receipt)).rejects.toThrow('disk full');
        await queue.flush();
        expect(queue.snapshot()).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
    });

    it('does not send a concurrently queued receipt before its write completes', async () => {
        const nextReceipt = { ...receipt, taskId: 43 };
        let releaseFirstSend!: () => void;
        const firstSendGate = new Promise<void>(resolve => { releaseFirstSend = resolve; });
        let firstSendStarted!: () => void;
        const firstSendStartedGate = new Promise<void>(resolve => { firstSendStarted = resolve; });
        let secondWriteStarted!: () => void;
        const secondWriteStartedGate = new Promise<void>(resolve => { secondWriteStarted = resolve; });
        let writeCount = 0;
        const delivered: number[] = [];
        const queue = new SyncAckQueue(async () => {
            writeCount += 1;
            if (writeCount === 2) {
                secondWriteStarted();
                throw new Error('disk full');
            }
        }, async ack => {
            if (ack.taskId === 42) {
                firstSendStarted();
                await firstSendGate;
            }
            delivered.push(ack.taskId);
            return 'accepted';
        });
        await queue.enqueue(receipt);
        const flushing = queue.flush();
        await firstSendStartedGate;
        const secondEnqueue = queue.enqueue(nextReceipt);
        await secondWriteStartedGate;
        await expect(secondEnqueue).rejects.toThrow('disk full');
        releaseFirstSend();
        await flushing;

        expect(delivered).toEqual([42]);
        expect(queue.snapshot()).toEqual([]);
    });
});
