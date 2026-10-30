import { requestUrl, type RequestUrlResponse } from 'obsidian';
import { CLIP2MD_API_BASE_URL } from './config';
import { favoriteIdentity, type FavoriteImportRequest, type FavoriteImportResponse, type TaskContext } from './companion-protocol';

interface ImportHost {
    credential(): string;
    scope(): Promise<string>;
    available(): boolean;
    localTasks(): Promise<Array<Pick<TaskContext, 'taskId' | 'sourceUrl' | 'cloudStatus'>>>;
    sync(ids: number[]): Promise<void>;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function body(response: RequestUrlResponse): Record<string, unknown> {
    try { return object(response.json); } catch { return {}; }
}
function header(response: RequestUrlResponse, name: string): string {
    return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '';
}
function quota(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('无法确认剩余额度，本次未提交');
    return value;
}
/** Only the host owns the cloud credential. Results are journaled before the next paid request. */
export class FavoriteLinkImporter {
    private busy = false;
    constructor(private host: ImportHost) {}
    async run(request: FavoriteImportRequest): Promise<FavoriteImportResponse> {
        if (this.busy) throw new Error('已有收藏导入正在提交，请等待完成');
        if (!request || !['bilibili', 'xiaohongshu', 'douyin'].includes(request.platform) || !Array.isArray(request.entries)
            || !/^[a-f0-9]{64}$/.test(request.bindingScope) || typeof request.shouldContinue !== 'function' || typeof request.onResult !== 'function')
            throw new Error('收藏导入请求无效');
        const key = this.host.credential();
        const current = async () => !!key && key === this.host.credential() && this.host.available()
            && await this.host.scope() === request.bindingScope && await request.shouldContinue();
        const check = async () => { if (!await current()) throw new Error('导入已暂停或绑定已变化；已提交任务保留'); };
        this.busy = true;
        const accepted = new Set<number>();
        const result: FavoriteImportResponse = { dailyQuota: 0, permanentQuota: 0, syncTriggered: false };
        try {
            await check();
            const accountResponse = await requestUrl({ url: `${CLIP2MD_API_BASE_URL}/auth/me`, headers: { 'X-API-Key': key }, throw: false });
            await check();
            if (accountResponse.status !== 200) throw new Error(accountResponse.status === 401 ? '绑定已失效，请重新绑定' : '额度查询失败，本次未提交');
            const account = body(accountResponse);
            result.dailyQuota = quota(account.daily_quota); result.permanentQuota = quota(account.permanent_quota);
            if (account.refund_pending === true || Array.isArray(account.allowed_task_types) && !account.allowed_task_types.includes('LINK'))
                throw new Error('当前账号暂不可创建链接任务，本次未提交');
            let budget = result.dailyQuota + result.permanentQuota;
            const existing = new Map<string, number>();
            for (const task of await this.host.localTasks()) {
                const identity = favoriteIdentity(task.sourceUrl);
                if (identity && task.cloudStatus !== 'failed') existing.set(identity.key, task.taskId);
            }
            // Bound each read request, without limiting the total import size.
            const urls = [...new Set(request.entries.flatMap(entry => {
                const identity = entry && typeof entry.url === 'string' ? favoriteIdentity(entry.url, request.platform) : undefined;
                return identity ? [identity.url] : [];
            }))];
            const requestKeys = new Map(request.entries.flatMap(entry => {
                const identity = entry && typeof entry.url === 'string' ? favoriteIdentity(entry.url, request.platform) : undefined;
                return identity && typeof entry.requestKey === 'string' && /^[a-zA-Z0-9:-]{16,128}$/.test(entry.requestKey) ? [[identity.url, entry.requestKey] as const] : [];
            }));
            for (let offset = 0; offset < urls.length; offset += 200) {
                await check();
                const batch = urls.slice(offset, offset + 200);
                const response = await requestUrl({ url: `${CLIP2MD_API_BASE_URL}/links/favorites/preflight`, method: 'POST',
                    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: batch, request_keys: Object.fromEntries(batch.flatMap(url => requestKeys.has(url) ? [[url, requestKeys.get(url)]] : [])) }), throw: false });
                await check();
                if (response.status !== 200) throw new Error(response.status === 404 ? '请更新服务端后使用收藏导入，本次未提交' : '无法检查已有任务，本次未提交');
                const data = body(response);
                if (!Array.isArray(data.matches) || data.matches.length !== batch.length) throw new Error('重复预检格式无效，本次未提交');
                const remaining = new Set(batch);
                for (const raw of data.matches) {
                    const match = object(raw);
                    if (typeof match.url !== 'string' || !remaining.delete(match.url)
                        || match.task_id !== null && (!Number.isSafeInteger(match.task_id) || Number(match.task_id) <= 0))
                        throw new Error('重复预检格式无效，本次未提交');
                    const identity = favoriteIdentity(match.url)!;
                    if (match.task_id !== null) existing.set(identity.key, Number(match.task_id));
                }
            }
            // Include durable receipts from an interrupted previous run, even if
            // every accepted entry has already been deselected in the UI.
            for (const id of request.acceptedTaskIds || []) if (Number.isSafeInteger(id) && id > 0) accepted.add(id);
            for (const entry of request.entries) {
                if (!await current()) { result.stopped = '导入已暂停；剩余项可继续导入'; break; }
                const identity = entry && typeof entry.url === 'string' ? favoriteIdentity(entry.url, request.platform) : undefined;
                if (!identity || typeof entry.requestKey !== 'string' || !/^[a-zA-Z0-9:-]{16,128}$/.test(entry.requestKey)) {
                    await request.onResult({ url: entry?.url || '', status: 'invalid', message: '只支持本平台的单条作品链接' }); continue;
                }
                const duplicate = existing.get(identity.key);
                if (duplicate) {
                    if (entry.reconcile) accepted.add(duplicate);
                    await request.onResult({ url: entry.url, status: 'duplicate', taskId: duplicate, ...(entry.reconcile ? { syncPending: true } : {}) }); continue;
                }
                if (budget <= 0) { await request.onResult({ url: entry.url, status: 'quota_skipped', message: '额度不足，未导入' }); continue; }
                await request.onSubmitting?.(entry.url);
                if (!await current()) { result.stopped = '导入已暂停；剩余项可继续导入'; break; }
                let response: RequestUrlResponse;
                try {
                    response = await requestUrl({ url: `${CLIP2MD_API_BASE_URL}/links/submit`, method: 'POST',
                        headers: { 'X-API-Key': key, 'Content-Type': 'application/json', 'Idempotency-Key': entry.requestKey },
                        body: JSON.stringify({ url: identity.url }), throw: false });
                } catch {
                    await request.onResult({ url: entry.url, status: 'failed', uncertain: true, message: '网络中断，请继续导入以确认提交结果' });
                    result.stopped = '网络中断，剩余项未提交'; break;
                }
                const data = body(response), detail = object(data.detail);
                const code = (header(response, 'X-Error-Code') || (typeof detail.code === 'string' ? detail.code : '')).toLowerCase();
                const prior = Number(detail.existing_task_id || data.existing_task_id || header(response, 'X-Existing-Task-Id'));
                if (response.status >= 200 && response.status < 300) {
                    const task = object(data.task);
                    if (data.kind !== 'task' || !Number.isSafeInteger(task.id) || Number(task.id) <= 0) {
                        await request.onResult({ url: entry.url, status: 'failed', uncertain: true, message: '无法确认任务结果，请继续导入核对' });
                        result.stopped = '任务响应无效，剩余项未提交'; break;
                    }
                    const taskId = Number(task.id);
                    existing.set(identity.key, taskId);
                    if (task.duplicate === true) {
                        if (entry.reconcile) accepted.add(taskId);
                        await request.onResult({ url: entry.url, status: 'duplicate', taskId, ...(entry.reconcile ? { syncPending: true } : {}) });
                    } else {
                        accepted.add(taskId); budget--;
                        await request.onResult({ url: entry.url, status: 'created', taskId });
                    }
                } else if (code === 'duplicate_link' && Number.isSafeInteger(prior) && prior > 0) {
                    existing.set(identity.key, prior);
                    if (entry.reconcile) accepted.add(prior);
                    await request.onResult({ url: entry.url, status: 'duplicate', taskId: prior, ...(entry.reconcile ? { syncPending: true } : {}) });
                } else if (['quota', 'permanent_quota'].includes(code)) {
                    budget = 0;
                    await request.onResult({ url: entry.url, status: 'quota_skipped', message: '额度不足，未导入' });
                } else if ([400, 422].includes(response.status)) {
                    await request.onResult({ url: entry.url, status: 'invalid', message: '链接无法识别，未导入' });
                } else {
                    const message = response.status === 401 ? '绑定已失效，请重新绑定' : code === 'pending_queue_limit' ? '排队任务已满，请等待后继续导入'
                        : response.status === 429 ? '提交受限，请稍后继续导入' : '服务暂不可用，请稍后继续导入';
                    await request.onResult({ url: entry.url, status: 'failed', message, ...(response.status >= 500 ? { uncertain: true } : {}) });
                    result.stopped = message; break;
                }
            }
            return result;
        } finally {
            try {
                // Also sync accepted tasks when a later item was cancelled or failed.
                if (accepted.size && key === this.host.credential() && this.host.available() && await this.host.scope() === request.bindingScope) {
                    result.syncTriggered = true;
                    await this.host.sync([...accepted]);
                }
            } finally { this.busy = false; }
        }
    }
}
