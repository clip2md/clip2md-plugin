import { requestUrl } from 'obsidian';
import { CLIP2MD_API_BASE_URL } from './config';
import type { BijiSyncSettings } from './settings';
import type { SyncResult, SyncTask } from './sync';

export interface PendingSyncAck {
    taskId: number;
    ackToken: string;
    imagesProcessed: number;
    imagesFailed: number;
}

type AckDisposition = 'accepted' | 'discard';

export class SyncAckHttpError extends Error {
    constructor(readonly status: number) {
        super(`Clip2MD 回执提交失败 (HTTP ${status})`);
        this.name = 'SyncAckHttpError';
    }
}

function isPendingSyncAck(value: unknown): value is PendingSyncAck {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return Number.isSafeInteger(item.taskId) && Number(item.taskId) > 0
        && typeof item.ackToken === 'string' && item.ackToken.length > 0
        && Number.isSafeInteger(item.imagesProcessed) && Number(item.imagesProcessed) >= 0
        && Number.isSafeInteger(item.imagesFailed) && Number(item.imagesFailed) >= 0;
}

export function parsePendingSyncAcks(value: unknown): PendingSyncAck[] {
    if (!Array.isArray(value)) return [];
    const byTask = new Map<number, PendingSyncAck>();
    for (const item of value) {
        if (isPendingSyncAck(item)) byTask.set(item.taskId, { ...item });
    }
    return [...byTask.values()];
}

/** Only explain withheld receipts when the server offered this device a deletion token. */
export function getSyncAckBlockedReason(
    task: SyncTask,
    result: SyncResult,
    settings: Pick<BijiSyncSettings, 'imageMode' | 'syncContentMode' | 'template'>,
): string | null {
    if (!task.ack_token || task.status !== 'SUCCESS') return null;
    if (result.skipped || !result.filepath) return 'Vault 文件未写入';
    if (settings.syncContentMode !== 'full') return '同步内容未选择“完整内容”';
    if (!settings.template.includes('{{content}}')) return '模板未包含完整正文 {{content}}';
    if (settings.imageMode !== 'local' && (task.asset_count > 0 || result.unlocalizedImages)) {
        return '图片未设置为本地保存';
    }
    if (result.failedAssets || task.asset_failed_count !== 0) return '部分图片保存失败';
    if (result.pendingAssets || task.asset_pending_count !== 0) return '图片仍在处理中';
    if (result.unlocalizedImages || (task.asset_count > 0
        && (task.asset_ready_count !== task.asset_count
            || (result.localizedAssetCount ?? 0) < task.asset_count))) {
        return '部分图片未保存到 Vault';
    }
    return null;
}

export function buildSyncAck(
    task: SyncTask,
    result: SyncResult,
    settings: Pick<BijiSyncSettings, 'imageMode' | 'syncContentMode' | 'template'>,
): PendingSyncAck | null {
    if (!task.ack_token || task.status !== 'SUCCESS' || getSyncAckBlockedReason(task, result, settings)) return null;
    return {
        taskId: task.id,
        ackToken: task.ack_token,
        imagesProcessed: task.asset_count,
        imagesFailed: 0,
    };
}

export async function postSyncAck(ack: PendingSyncAck, apiKey: string): Promise<AckDisposition> {
    const response = await requestUrl({
        url: `${CLIP2MD_API_BASE_URL}/sync/tasks/${ack.taskId}/ack`,
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ack_token: ack.ackToken,
            vault_write_ok: true,
            images_processed: ack.imagesProcessed,
            images_failed: ack.imagesFailed,
        }),
        throw: false,
    });
    if (response.status >= 200 && response.status < 300) return 'accepted';
    // A malformed/foreign token cannot become valid on retry. In particular,
    // an old account's receipt must not block receipts from a newly bound key.
    if (response.status === 400 || response.status === 404
        || response.status === 409 || response.status === 422) return 'discard';
    throw new SyncAckHttpError(response.status);
}

/** The receipt is saved before the first network request and removed only after a final server response. */
export class SyncAckQueue {
    private pending: PendingSyncAck[] = [];
    private flushing: Promise<void> | null = null;
    private mutation: Promise<void> = Promise.resolve();

    constructor(
        private readonly persist: () => Promise<void>,
        private readonly deliver: (ack: PendingSyncAck) => Promise<AckDisposition>,
    ) {}

    load(value: unknown): void {
        this.pending = parsePendingSyncAcks(value);
    }

    snapshot(): PendingSyncAck[] {
        return this.pending.map(item => ({ ...item }));
    }

    enqueue(ack: PendingSyncAck): Promise<void> {
        return this.mutate(before => [...before.filter(item => item.taskId !== ack.taskId), { ...ack }]);
    }

    remove(taskId: number): Promise<void> {
        return this.mutate(before => before.some(item => item.taskId === taskId)
            ? before.filter(item => item.taskId !== taskId)
            : before);
    }

    async flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        this.flushing = this.drain().finally(() => { this.flushing = null; });
        return this.flushing;
    }

    private async drain(): Promise<void> {
        while (true) {
            const pendingMutation = this.mutation;
            await pendingMutation.catch(() => undefined);
            if (pendingMutation !== this.mutation) continue;
            const ack = this.pending[0];
            if (!ack) return;
            try {
                await this.deliver(ack);
            } catch (error) {
                console.warn(`Clip2MD: 任务 ${ack.taskId} 回执待重试`, error);
                return;
            }
            // A newer receipt can replace this one while the request is in flight.
            try {
                await this.mutate(before => before.includes(ack) ? before.filter(item => item !== ack) : before);
            } catch (error) {
                console.warn(`Clip2MD: 任务 ${ack.taskId} 回执状态保存失败`, error);
                return;
            }
        }
    }

    private mutate(change: (before: PendingSyncAck[]) => PendingSyncAck[]): Promise<void> {
        const next = this.mutation.catch(() => undefined).then(async () => {
            const before = this.pending;
            const updated = change(before);
            if (updated === before) return;
            this.pending = updated;
            try {
                await this.persist();
            } catch (error) {
                this.pending = before;
                throw error;
            }
        });
        this.mutation = next;
        return next;
    }
}
