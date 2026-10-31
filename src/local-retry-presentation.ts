export interface LocalRetryLocalRecord {
    taskId: number;
    kind: 'dispatch' | 'monitor';
    sourceTitle?: string;
    capturedAt?: string;
    updatedAt?: string;
    inputId?: string;
    submitted?: boolean;
    monitorStatus?: string;
    error?: string;
    stoppedReason?: string;
}

export interface LocalRetryCloudJob {
    taskId: number;
    status: string;
    reason?: string;
    updatedAt?: string;
}

export interface LocalRetryPresentation {
    taskId: number;
    title: string;
    currentStatus: string;
    error: string;
    needsAuthorization: boolean;
    history: string[];
}

const CLOUD_STATUS_LABELS: Record<string, string> = {
    WAITING_DEVICE: '等待本地扩展',
    QUEUED: '排队中',
    PARSING: '本地解析中',
    UPLOADING: '回传中',
    WAITING_AUTH: '等待原站授权',
    GENERATING: '云端生成中',
    COMPLETED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
    SUPERSEDED: '任务已变化',
};

const REASON_LABELS: Record<string, string> = {
    authorization_required: '需要完成原站授权',
    local_failed: '本地解析失败',
    quota: '额度或权限不足',
    network: '网络连接失败',
    refund_pending: '等待退款处理完成',
    policy_changed: '自动处理设置已变化',
    task_changed: '任务内容已变化',
    cloud_failed: '云端生成失败',
    user_resumed: '任务已恢复',
    desktop_unready: '本地扩展尚未准备好',
};

const MONITOR_STAGE_LABELS: Record<string, string> = {
    'awaiting-local-sync': '云端生成完成，等待同步到本地',
    failed: '本地监听到云端生成失败',
    superseded: '本地监听到任务已变化',
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const validTaskId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function reasonLabel(reason: unknown): string {
    const value = text(reason);
    return value ? REASON_LABELS[value] || value : '';
}

function formatHistoryTime(value: unknown): string {
    const source = text(value);
    if (!source) return '';
    const date = new Date(source);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { hour12: false });
}

function localStage(record: LocalRetryLocalRecord): string {
    if (record.kind === 'dispatch') {
        if (text(record.stoppedReason)) return '本地处理已暂停';
        if (record.submitted) return '本地解析与回传已完成';
        if (text(record.inputId)) return '本地解析完成，回传待确认';
        return '本地解析已记录';
    }
    const monitored = MONITOR_STAGE_LABELS[text(record.monitorStatus)];
    if (monitored) return monitored;
    return record.submitted ? '已提交云端，等待生成结果' : '本地监测已记录';
}

/** Parse the cloud payload without allowing malformed rows to become current state. */
export function parseLocalRetryCloudJobs(value: unknown): LocalRetryCloudJob[] | null {
    if (!value || typeof value !== 'object') return null;
    const items = (value as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    const jobs: LocalRetryCloudJob[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const job = item as Record<string, unknown>;
        if (!validTaskId(job.task_id) || !text(job.status)) continue;
        jobs.push({
            taskId: job.task_id,
            status: text(job.status),
            reason: text(job.reason) || undefined,
            updatedAt: text(job.updated_at) || undefined,
        });
    }
    return jobs;
}

/**
 * Cloud state is authoritative. Local rows only enrich that row; timestamps
 * are deliberately not used to infer which processing stage is newest.
 */
export function presentLocalRetries(
    localRecords: LocalRetryLocalRecord[],
    cloudJobs: LocalRetryCloudJob[],
    cloudAvailable: boolean,
): LocalRetryPresentation[] {
    const grouped = new Map<number, { cloud?: LocalRetryCloudJob; local: LocalRetryLocalRecord[] }>();
    for (const cloud of cloudJobs) {
        if (!validTaskId(cloud.taskId)) continue;
        const group = grouped.get(cloud.taskId) || { local: [] };
        // The endpoint supplies its preferred order; never compare local and
        // cloud timestamps to choose a current state.
        if (!group.cloud) group.cloud = cloud;
        grouped.set(cloud.taskId, group);
    }
    for (const record of localRecords) {
        if (!validTaskId(record.taskId)) continue;
        const group = grouped.get(record.taskId) || { local: [] };
        group.local.push(record);
        grouped.set(record.taskId, group);
    }
    return [...grouped.entries()].map(([taskId, group]) => {
        const cloud = cloudAvailable ? group.cloud : undefined;
        const sourceTitle = group.local.map(record => text(record.sourceTitle)).find(Boolean) || '';
        const needsAuthorization = cloud?.status === 'WAITING_AUTH';
        const errors: string[] = [];
        if (cloud?.reason && !(needsAuthorization && cloud.reason === 'authorization_required'))
            errors.push(`云端：${reasonLabel(cloud.reason)}`);
        const localErrors = new Set<string>();
        const localReasons = new Set<string>();
        for (const record of group.local) {
            if (text(record.error)) localErrors.add(text(record.error));
            if (text(record.stoppedReason) && !(needsAuthorization && record.stoppedReason === 'authorization_required'))
                localReasons.add(reasonLabel(record.stoppedReason));
        }
        // Prefer the verified error detail over a generic pause reason when both
        // describe the same stopped dispatch.
        if (localErrors.size)
            localReasons.delete('本地解析失败');
        for (const reason of localReasons) localErrors.add(reason);
        for (const error of localErrors) errors.push(`本地：${error}`);
        const history = [...new Set(group.local.map(record => {
            const time = formatHistoryTime(record.updatedAt || record.capturedAt);
            return `${localStage(record)}${time ? ` · ${time}` : ''}`;
        }))];
        return {
            taskId,
            title: sourceTitle || `任务 #${taskId}`,
            currentStatus: cloud ? CLOUD_STATUS_LABELS[cloud.status] || '云端状态未知' : cloudAvailable ? '云端暂无对应记录' : '当前状态待联网确认',
            error: [...new Set(errors)].join('\n'),
            needsAuthorization,
            history,
        };
    });
}
