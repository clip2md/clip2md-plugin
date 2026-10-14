import { requestUrl } from 'obsidian';
import { CLIP2MD_API_BASE_URL } from './config';

export interface RelatedWork { subscription_id?: number; work_id?: string; task_id?: number | null; url?: string; title?: string; }
export interface SubscriptionContext {
    kind: 'work' | 'comment_supplement' | 'daily_report';
    account_id: string;
    subscription_id?: number;
    platform?: string;
    blogger_id?: string;
    nickname?: string | null;
    remark?: string | null;
    homepage?: string;
    work_id?: string;
    work_record_id?: number;
    original_task_id?: number | null;
    original_url?: string | null;
    published_at?: string | null;
    published_text?: string | null;
    published_kind?: string;
    first_discovered_at?: string;
    report_date?: string;
    related_works?: RelatedWork[];
}
export interface BloggerRule { folder?: string; enabled?: boolean; }
export interface ArchiveConfig {
    enabled: boolean;
    folderTemplate: string;
    indexEnabled: boolean;
    reportsEnabled: boolean;
    reportFolder: string;
    bloggers: Record<string, BloggerRule>;
}
export interface BloggerInfo {
    id: number; platform: string; blogger_id: string; name: string; homepage: string;
    profile: { nickname?: string }; ends_at: string;
    last_scan: null | { status: string; scheduled_at: string; completed_at?: string; error_code?: string; new_work_count: number };
}
export interface CloudWork {
    id: number; work_id: string; subscription_id: number; platform: string; url: string;
    metadata: { caption?: string; published_at?: string }; baseline: boolean; first_discovered_at: string;
    task_id: number | null; clip_status: string | null; clip_outcome: string | null;
    supplement_task_id: number | null; comment_status: string | null;
    supplement_status?: string | null;
}
export interface CloudReport { date: string; generated_at: string; task_id: number | null; status: string | null; }
export interface ArchiveSnapshot {
    account_id: string; features: Record<string, boolean>; items: BloggerInfo[];
    works: CloudWork[]; reports: CloudReport[]; fetchedAt: string;
}
export interface SubscriptionDeviceState {
    unverified?: boolean;
    version: 1;
    accountId?: string;
    credentialFingerprint?: string;
    snapshot?: ArchiveSnapshot;
    excludedTaskIds: number[];
    statuses: Record<string, { status: 'pending' | 'synced' | 'excluded' | 'conflict' | 'images' | 'error'; message?: string }>;
    keptLocalTaskIds: number[];
    keptIndexIds?: number[];
    legacyProofs?: Record<string, { filepath: string; contentHash: string }>;
}
export const DEFAULT_ARCHIVE_CONFIG: ArchiveConfig = {
    enabled: false, folderTemplate: 'Clip2MD/博主订阅/{{platform}}/{{blogger_name}}',
    indexEnabled: true, reportsEnabled: true, reportFolder: 'Clip2MD/博主订阅/日报', bloggers: {},
};
export function archiveConfig(raw?: Partial<ArchiveConfig>): ArchiveConfig {
    const bloggers: Record<string, BloggerRule> = {};
    if (raw?.bloggers && typeof raw.bloggers === 'object') for (const [id, rule] of Object.entries(raw.bloggers)) {
        if (/^[1-9]\d*$/.test(id) && rule && typeof rule === 'object') bloggers[id] = {
            enabled: rule.enabled !== false, folder: typeof rule.folder === 'string' ? rule.folder : undefined,
        };
    }
    return { enabled: raw?.enabled === true,
        folderTemplate: typeof raw?.folderTemplate === 'string' && raw.folderTemplate.trim() ? raw.folderTemplate : DEFAULT_ARCHIVE_CONFIG.folderTemplate,
        indexEnabled: raw?.indexEnabled !== false, reportsEnabled: raw?.reportsEnabled !== false,
        reportFolder: typeof raw?.reportFolder === 'string' && raw.reportFolder.trim() ? raw.reportFolder : DEFAULT_ARCHIVE_CONFIG.reportFolder,
        bloggers };
}
export function newSubscriptionState(): SubscriptionDeviceState {
    return { version: 1, excludedTaskIds: [], statuses: {}, keptLocalTaskIds: [] };
}
export function bloggerName(context: SubscriptionContext): string {
    return context.remark?.trim() || context.nickname?.trim() || context.blogger_id || String(context.subscription_id || '未知博主');
}
export function isSubscriptionContext(value: unknown): value is SubscriptionContext {
    if (!value || typeof value !== 'object') return false;
    const c = value as SubscriptionContext;
    return typeof c.account_id === 'string' && !!c.account_id
        && ['work', 'comment_supplement', 'daily_report'].includes(c.kind)
        && (c.kind === 'daily_report' ? /^\d{4}-\d{2}-\d{2}$/.test(c.report_date || '')
            : Number.isSafeInteger(c.subscription_id) && c.subscription_id! > 0
                && typeof c.blogger_id === 'string' && !!c.blogger_id && typeof c.work_id === 'string' && !!c.work_id);
}
export function isExcluded(context: SubscriptionContext, config: ArchiveConfig): boolean {
    return context.kind === 'daily_report' ? !config.reportsEnabled
        : config.bloggers[String(context.subscription_id)]?.enabled === false;
}

export class ArchiveRequestError extends Error {
    constructor(readonly status: number) { super(status === 404 ? '服务器暂不支持博主订阅面板' : `订阅接口请求失败 (${status})`); }
}
export async function fetchArchiveSnapshot(apiKey: string): Promise<ArchiveSnapshot> {
    async function get(path: string) {
        const response = await requestUrl({ url: `${CLIP2MD_API_BASE_URL}/sync/${path}`,
            headers: { 'X-API-Key': apiKey }, throw: false });
        if (response.status !== 200) throw new ArchiveRequestError(response.status);
        return response.json;
    }
    const listing = await get('bloggers');
    if (typeof listing.account_id !== 'string' || !Array.isArray(listing.items)) throw new Error('订阅列表格式无效');
    async function pages<T>(path: string): Promise<T[]> {
        const items: T[] = [];
        for (let page = 1; page <= 10000; page++) {
            const data = await get(`${path}?page=${page}&limit=200`);
            if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total)) throw new Error('订阅分页格式无效');
            items.push(...data.items);
            if (items.length >= data.total) return items;
            if (!data.items.length) throw new Error('订阅分页未推进，请刷新重试');
        }
        throw new Error('订阅分页超过安全上限，请缩小保留范围后重试');
    }
    const [works, reports] = await Promise.all([pages<CloudWork>('bloggers/works'), pages<CloudReport>('bloggers/reports')]);
    return { ...listing, works, reports, fetchedAt: new Date().toISOString() };
}
