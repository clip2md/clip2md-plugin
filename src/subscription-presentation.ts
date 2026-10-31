import { formatBeijingDateTime } from './date-format';
import { subscriptionPlatformLabel } from './subscription-settings-page';

export type SubscriptionCloudFilter = '' | 'cloud-pending' | 'cloud-failed' | 'cloud-none' | 'cloud-unknown' | 'cloud-success';
export type SubscriptionStatusTone = 'success' | 'pending' | 'error' | 'muted';

export interface SubscriptionPresentation {
    cloudFilter: Exclude<SubscriptionCloudFilter, ''>;
    local: string;
    needsAttention: boolean;
    label: string;
    tone: SubscriptionStatusTone;
    detail: string;
}

export function subscriptionCloudFilter(cloud: string | null, localOnly = false): Exclude<SubscriptionCloudFilter, ''> {
    if (localOnly || cloud === 'SUCCESS') return 'cloud-success';
    if (['PENDING', 'PROCESSING', 'WAITING_SERVICE'].includes(cloud || '')) return 'cloud-pending';
    if (cloud?.startsWith('FAILED')) return 'cloud-failed';
    if (cloud === null) return 'cloud-none';
    return 'cloud-unknown';
}

/** Keep the default view, badges and cloud filters on the same status model. */
export function subscriptionPresentation(input: {
    cloud: string | null;
    local: string;
    baseline: boolean;
    localOnly: boolean;
}): SubscriptionPresentation {
    const cloudFilter = subscriptionCloudFilter(input.cloud, input.localOnly);
    const localLabels: Record<string, string> = {
        pending: '待同步', synced: '已同步', excluded: '已排除', conflict: '批注冲突',
        images: '图片处理失败', error: '本地同步失败',
    };
    const local = input.local || (cloudFilter === 'cloud-none' ? '' : 'pending');
    let label = '';
    let tone: SubscriptionStatusTone = 'muted';
    let needsAttention = false;
    if (['conflict', 'images', 'error'].includes(local)) {
        label = localLabels[local]; tone = 'error'; needsAttention = true;
    } else if (input.local === 'excluded') {
        label = '已排除';
    } else if (cloudFilter === 'cloud-failed' || cloudFilter === 'cloud-unknown') {
        label = cloudFilter === 'cloud-failed' ? '云端失败' : '云端状态未知';
        tone = 'error'; needsAttention = true;
    } else if (cloudFilter === 'cloud-pending') {
        label = '云端处理中'; tone = 'pending'; needsAttention = true;
    } else if (cloudFilter === 'cloud-none') {
        label = input.baseline ? '历史未剪藏' : '待剪藏';
        needsAttention = !input.baseline;
        tone = needsAttention ? 'pending' : 'muted';
    } else if (local === 'pending') {
        label = '待同步'; tone = 'pending'; needsAttention = true;
    } else if (input.localOnly) {
        label = '本地已保存'; tone = 'success';
    } else {
        label = '已同步'; tone = 'success';
    }
    return {
        cloudFilter, local, needsAttention, label, tone,
        detail: input.baseline ? '历史作品' : '',
    };
}

export function subscriptionWorkMeta(platform: string | undefined, kind: string): string {
    const type = kind === 'work' ? '作品' : kind === 'comment_supplement' ? '评论补充' : '日报';
    return platform ? `${subscriptionPlatformLabel(platform)} · ${type}` : type;
}

export function formatSubscriptionDate(value: string | undefined): string {
    if (!value) return '暂无';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value.slice(0, 10);
    return formatBeijingDateTime(date.toISOString()).slice(0, 16);
}
