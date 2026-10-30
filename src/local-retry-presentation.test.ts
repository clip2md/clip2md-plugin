import { describe, expect, it } from 'vitest';
import {
    parseLocalRetryCloudJobs,
    presentLocalRetries,
    type LocalRetryLocalRecord,
} from './local-retry-presentation';

const local: LocalRetryLocalRecord[] = [
    {
        taskId: 42,
        kind: 'dispatch',
        sourceTitle: '原文标题',
        inputId: 'input-42',
        submitted: true,
        stoppedReason: 'local_failed',
        error: '完整的本地解析错误，不能截断。',
        updatedAt: '2099-01-01T00:00:00Z',
    },
    {
        taskId: 42,
        kind: 'monitor',
        sourceTitle: '原文标题',
        inputId: 'input-42',
        submitted: true,
        monitorStatus: 'failed',
        updatedAt: '2099-01-02T00:00:00Z',
    },
];

describe('local recovery presentation', () => {
    it('uses cloud state even when local timestamps are later, and merges history by task', () => {
        const items = presentLocalRetries(local, [{
            taskId: 42,
            status: 'COMPLETED',
            updatedAt: '2020-01-01T00:00:00Z',
        }], true);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            taskId: 42,
            title: '原文标题',
            currentStatus: '已完成',
            needsAuthorization: false,
        });
        expect(items[0].history).toHaveLength(2);
        expect(items[0].history.join(' ')).toContain('本地处理已暂停');
        expect(items[0].history.join(' ')).toContain('本地监听到云端生成失败');
        expect(items[0].error).toBe('本地：完整的本地解析错误，不能截断。');
        expect(JSON.stringify(items[0])).not.toContain('COMPLETED');
        expect(JSON.stringify(items[0])).not.toContain('FAILED');
    });

    it('never invents a current cloud state while offline but retains local errors', () => {
        const items = presentLocalRetries(local, [{
            taskId: 42,
            status: 'COMPLETED',
        }], false);
        expect(items).toHaveLength(1);
        expect(items[0].currentStatus).toBe('当前状态待联网确认');
        expect(items[0].needsAuthorization).toBe(false);
        expect(items[0].error).toContain('完整的本地解析错误');
        expect(items[0].history).toHaveLength(2);
    });

    it('shows one current Chinese status and exposes authorization only for the cloud state', () => {
        const items = presentLocalRetries([
            { taskId: 7, kind: 'dispatch', sourceTitle: '', stoppedReason: 'authorization_required' },
        ], [
            { taskId: 7, status: 'WAITING_AUTH', reason: 'authorization_required' },
            { taskId: 8, status: 'GENERATING' },
            { taskId: 9, status: 'UNRECOGNIZED_FUTURE_STATE' },
        ], true);
        expect(items.map(item => [item.taskId, item.currentStatus])).toEqual([
            [7, '等待原站授权'],
            [8, '云端生成中'],
            [9, '云端状态未知'],
        ]);
        expect(items[0].needsAuthorization).toBe(true);
        expect(items[0].error).toBe('');
        expect(JSON.stringify(items)).not.toContain('UNRECOGNIZED_FUTURE_STATE');
    });

    it('keeps a local title and history without guessing when the cloud has no corresponding row', () => {
        const items = presentLocalRetries(local, [], true);
        expect(items[0].title).toBe('原文标题');
        expect(items[0].currentStatus).toBe('云端暂无对应记录');
        expect(items[0].history).toHaveLength(2);
    });

    it('validates the cloud envelope and ignores malformed jobs', () => {
        expect(parseLocalRetryCloudJobs(undefined)).toBeNull();
        expect(parseLocalRetryCloudJobs({ items: 'not-an-array' })).toBeNull();
        expect(parseLocalRetryCloudJobs({ items: [
            null,
            { task_id: 42, status: 'FAILED', reason: 'cloud_failed', updated_at: '2026-01-01T00:00:00Z' },
            { task_id: 'wrong', status: 'COMPLETED' },
            { task_id: 43 },
        ] })).toEqual([{
            taskId: 42,
            status: 'FAILED',
            reason: 'cloud_failed',
            updatedAt: '2026-01-01T00:00:00Z',
        }]);
    });
});
