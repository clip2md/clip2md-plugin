import { requestUrl } from 'obsidian';
import { CLIP2MD_API_BASE_URL } from './config';
import type { BijiSyncSettings } from './settings';
import type { SyncResult, SyncTask } from './sync';
import type { ImageMode, SyncContentMode } from './settings';
import type { SavedSyncProof } from './saved-sync-proof';

export interface PendingSyncAck {
    taskId: number;
    ackToken: string;
    imagesProcessed: number;
    imagesFailed: number;
    scopeVersion?: 2;
    contentMode?: SyncContentMode;
    processedAssetIds?: number[];
    subsetConfirmed?: boolean;
    savedProof?: SavedSyncProof;
    imageMode?: ImageMode;
    imagesOmittedConfirmed?: boolean;
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
        && Number.isSafeInteger(item.imagesFailed) && Number(item.imagesFailed) >= 0
        && (item.scopeVersion === undefined || (item.scopeVersion === 2
            && ['full', 'source', 'note'].includes(String(item.contentMode))
            && (item.contentMode === 'full' || item.subsetConfirmed === true)
            && (item.imageMode === undefined || item.imageMode === 'local' || (item.imageMode === 'disabled' && item.imagesOmittedConfirmed === true))
            && Array.isArray(item.processedAssetIds)
            && item.processedAssetIds.every(id => Number.isSafeInteger(id) && Number(id) > 0)
            && item.savedProof !== null && typeof item.savedProof === 'object'
            && typeof (item.savedProof as SavedSyncProof).filepath === 'string'
            && typeof (item.savedProof as SavedSyncProof).contentHash === 'string'
            && Array.isArray((item.savedProof as SavedSyncProof).images)
            && (item.savedProof as SavedSyncProof).images.every(image => image && typeof image.path === 'string' && typeof image.hash === 'string')));
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
    if (task.ack_scope) {
        if (task.ack_scope.content_mode !== settings.syncContentMode) return '同步模式已变化，请重新同步';
        if ((task.ack_scope.image_mode ?? 'local') !== settings.imageMode) return '图片同步设置已变化或服务端尚未支持，请重新同步';
        if (result.failedAssets) return result.imageErrors?.join('；') || '部分图片保存失败';
        if (result.pendingAssets) return result.imageErrors?.join('；') || '图片仍在处理中';
        if (result.imageErrors?.length) return result.imageErrors.join('；');
        if (!result.selectedContentWritten || !result.savedProof) return '所选正文为空或模板未完整输出所选正文';
        if (settings.imageMode === 'disabled' && !result.imagesOmitted) return '尚未核验去图后的正文';
        const ids = task.ack_scope.required_assets.map(asset => asset.id).sort((a, b) => a - b);
        if (result.unlocalizedImages || JSON.stringify(result.verifiedAssetIds) !== JSON.stringify(ids)
            || task.ack_scope.required_assets.some(asset => asset.status !== 'READY')) return '所选正文的图片尚未完整保存到 Vault';
        return null;
    }
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
    subsetConfirmed = false,
): PendingSyncAck | null {
    if (!task.ack_token || task.status !== 'SUCCESS' || getSyncAckBlockedReason(task, result, settings)) return null;
    if (task.ack_scope) {
        if ((settings.syncContentMode !== 'full' || settings.imageMode === 'disabled') && !subsetConfirmed) return null;
        return {
            taskId: task.id, ackToken: task.ack_token,
            imagesProcessed: result.verifiedAssetIds!.length, imagesFailed: 0,
            scopeVersion: 2, contentMode: settings.syncContentMode,
            processedAssetIds: result.verifiedAssetIds, subsetConfirmed,
            savedProof: result.savedProof,
            imageMode: settings.imageMode,
            imagesOmittedConfirmed: settings.imageMode === 'disabled' && subsetConfirmed,
        };
    }
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
            ...(ack.scopeVersion === 2 ? {
                scope_version: 2, content_mode: ack.contentMode,
                processed_asset_ids: ack.processedAssetIds, subset_confirmed: ack.subsetConfirmed,
                image_mode: ack.imageMode ?? 'local', images_omitted_confirmed: ack.imagesOmittedConfirmed ?? false,
            } : {}),
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
