import { requestUrl } from 'obsidian';
import { CLIP2MD_API_BASE_URL } from './config';
import { nowBeijingDateTime } from './date-format';

export interface RelatedWork { subscription_id?: number | null; work_id?: string | null; task_id?: number | null; url?: string | null; title?: string | null; }
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
    id: number; platform: string; blogger_id: string; name: string | null; homepage: string;
    profile: { nickname?: string | null }; ends_at: string;
    last_scan: null | { status: string; scheduled_at: string; completed_at?: string | null; error_code?: string | null; new_work_count: number };
}
export interface CloudWork {
    id: number; work_id: string; subscription_id: number; platform: string; url: string;
    metadata: { caption?: string | null; published_at?: string | null }; baseline: boolean; first_discovered_at: string;
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
    enabled: false, folderTemplate: '',
    indexEnabled: true, reportsEnabled: true, reportFolder: '', bloggers: {},
};
export function archiveConfig(input?: unknown): ArchiveConfig {
    const raw = isArchiveRecord(input) ? input : undefined;
    const bloggers: Record<string, BloggerRule> = {};
    if (raw?.bloggers && typeof raw.bloggers === 'object') for (const [id, rule] of Object.entries(raw.bloggers)) {
        if (/^[1-9]\d*$/.test(id) && isArchiveRecord(rule)) bloggers[id] = {
            enabled: rule.enabled !== false, folder: typeof rule.folder === 'string' ? rule.folder : undefined,
        };
    }
    return { enabled: raw?.enabled === true,
        folderTemplate: typeof raw?.folderTemplate === 'string' && raw.folderTemplate !== 'Clip2MD/博主订阅/{{platform}}/{{blogger_name}}' ? raw.folderTemplate.trim() : DEFAULT_ARCHIVE_CONFIG.folderTemplate,
        indexEnabled: raw?.indexEnabled !== false, reportsEnabled: raw?.reportsEnabled !== false,
        reportFolder: typeof raw?.reportFolder === 'string' && raw.reportFolder !== 'Clip2MD/博主订阅/日报' ? raw.reportFolder.trim() : DEFAULT_ARCHIVE_CONFIG.reportFolder,
        bloggers };
}
/** Blank directories follow the main target, while explicit paths remain independent. */
export function resolvedArchiveConfig(config: ArchiveConfig, mainFolder: string): ArchiveConfig {
    const root = (mainFolder || 'Clip2MD').replace(/\\/g, '/').replace(/\/+$/, '');
    const child = (path: string) => [root, path].filter(Boolean).join('/');
    return { ...config,
        folderTemplate: config.folderTemplate.trim() || child('博主订阅/{{platform}}/{{blogger_name}}'),
        reportFolder: config.reportFolder.trim() || child('博主订阅/日报'),
    };
}
export function newSubscriptionState(): SubscriptionDeviceState {
    return { version: 1, excludedTaskIds: [], statuses: {}, keptLocalTaskIds: [] };
}
export function bloggerName(context: SubscriptionContext): string {
    return context.remark?.trim() || context.nickname?.trim() || context.blogger_id || String(context.subscription_id || '未知博主');
}
export function isArchiveRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const string = (value: unknown): value is string => typeof value === 'string';
const optionalString = (value: unknown) => value === undefined || string(value);
const nullableString = (value: unknown) => value === null || string(value);
const optionalNullableString = (value: unknown) => value === undefined || nullableString(value);
export const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nullableId = (value: unknown) => value === null || positiveId(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isSubscriptionContext(value: unknown): value is SubscriptionContext {
    if (!isArchiveRecord(value)) return false;
    return string(value.account_id) && !!value.account_id
        && (value.kind === 'work' || value.kind === 'comment_supplement' || value.kind === 'daily_report')
        && (value.kind === 'daily_report' ? string(value.report_date) && /^\d{4}-\d{2}-\d{2}$/.test(value.report_date)
            : positiveId(value.subscription_id) && string(value.blogger_id) && !!value.blogger_id && string(value.work_id) && !!value.work_id)
        && ['platform', 'homepage', 'published_kind', 'first_discovered_at'].every(key => optionalString(value[key]))
        && ['nickname', 'remark', 'original_url', 'published_at', 'published_text'].every(key => optionalNullableString(value[key]))
        && (value.work_record_id === undefined || positiveId(value.work_record_id))
        && (value.original_task_id === undefined || nullableId(value.original_task_id))
        && (value.related_works === undefined || Array.isArray(value.related_works) && value.related_works.every(ref =>
            isArchiveRecord(ref) && (ref.subscription_id == null || positiveId(ref.subscription_id))
            && (ref.task_id === undefined || nullableId(ref.task_id))
            && ['work_id', 'url', 'title'].every(key => optionalNullableString(ref[key]))));
}
export function isBloggerInfo(value: unknown): value is BloggerInfo {
    if (!isArchiveRecord(value)) return false;
    const scan = value.last_scan;
    return positiveId(value.id) && string(value.platform) && string(value.blogger_id)
        && nullableString(value.name) && string(value.homepage) && string(value.ends_at)
        && isArchiveRecord(value.profile) && optionalNullableString(value.profile.nickname)
        && (scan === null || isArchiveRecord(scan) && string(scan.status) && string(scan.scheduled_at)
            && optionalNullableString(scan.completed_at) && optionalNullableString(scan.error_code) && nonnegative(scan.new_work_count));
}
export function isCloudWork(value: unknown): value is CloudWork {
    return isArchiveRecord(value) && positiveId(value.id) && positiveId(value.subscription_id)
        && string(value.work_id) && string(value.platform) && string(value.url) && isArchiveRecord(value.metadata)
        && optionalNullableString(value.metadata.caption) && optionalNullableString(value.metadata.published_at)
        && typeof value.baseline === 'boolean' && string(value.first_discovered_at)
        && nullableId(value.task_id) && nullableId(value.supplement_task_id)
        && nullableString(value.clip_status) && nullableString(value.clip_outcome) && nullableString(value.comment_status)
        && optionalNullableString(value.supplement_status);
}
export function isCloudReport(value: unknown): value is CloudReport {
    return isArchiveRecord(value) && string(value.date) && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
        && string(value.generated_at) && nullableId(value.task_id) && nullableString(value.status);
}
function isListing(value: unknown): value is Pick<ArchiveSnapshot, 'account_id' | 'features' | 'items'> & Record<string, unknown> {
    return isArchiveRecord(value) && string(value.account_id) && !!value.account_id
        && isArchiveRecord(value.features) && Object.values(value.features).every(flag => typeof flag === 'boolean')
        && Array.isArray(value.items) && value.items.every(isBloggerInfo);
}
export function isArchiveSnapshot(value: unknown): value is ArchiveSnapshot {
    return isListing(value) && isArchiveRecord(value) && string(value.fetchedAt)
        && Array.isArray(value.works) && value.works.every(isCloudWork)
        && Array.isArray(value.reports) && value.reports.every(isCloudReport);
}
export function isSubscriptionDeviceState(value: unknown): value is SubscriptionDeviceState {
    if (!isArchiveRecord(value) || value.version !== 1) return false;
    const ids = (raw: unknown) => Array.isArray(raw) && raw.every(positiveId);
    return (value.unverified === undefined || typeof value.unverified === 'boolean')
        && optionalString(value.accountId) && optionalString(value.credentialFingerprint)
        && ids(value.excludedTaskIds) && ids(value.keptLocalTaskIds)
        && (value.keptIndexIds === undefined || ids(value.keptIndexIds))
        && isArchiveRecord(value.statuses) && Object.entries(value.statuses).every(([id, item]) => positiveId(Number(id))
            && isArchiveRecord(item) && ['pending', 'synced', 'excluded', 'conflict', 'images', 'error'].includes(String(item.status))
            && optionalString(item.message))
        && (value.snapshot === undefined || isArchiveSnapshot(value.snapshot) && value.snapshot.account_id === value.accountId)
        && (value.legacyProofs === undefined || isArchiveRecord(value.legacyProofs) && Object.entries(value.legacyProofs).every(([id, proof]) =>
            positiveId(Number(id)) && isArchiveRecord(proof) && string(proof.filepath) && string(proof.contentHash)));
}
export function isExcluded(context: SubscriptionContext, config: ArchiveConfig): boolean {
    return context.kind === 'daily_report' ? !config.reportsEnabled
        : config.bloggers[String(context.subscription_id)]?.enabled === false;
}

export type ArchiveErrorKind = 'network' | 'authentication' | 'format' | 'unsupported' | 'server';
export class ArchiveRequestError extends Error {
    readonly kind: ArchiveErrorKind;
    constructor(readonly status: number) {
        super(status === 404 ? '服务器暂不支持博主订阅面板' : status === 401 || status === 403 ? '订阅凭证无效或无权访问，请重新验证' : `订阅接口请求失败 (${status})`);
        this.kind = status === 404 ? 'unsupported' : status === 401 || status === 403 ? 'authentication' : 'server';
    }
}
export class ArchiveFormatError extends Error {
    readonly kind = 'format';
}
export async function fetchArchiveSnapshot(apiKey: string): Promise<ArchiveSnapshot> {
    async function get(path: string): Promise<unknown> {
        const response = await requestUrl({ url: `${CLIP2MD_API_BASE_URL}/sync/${path}`,
            headers: { 'X-API-Key': apiKey }, throw: false });
        if (response.status !== 200) throw new ArchiveRequestError(response.status);
        try {
            const data: unknown = response.json;
            return data;
        } catch { throw new ArchiveFormatError('订阅接口未返回有效 JSON'); }
    }
    const listing = await get('bloggers');
    if (!isListing(listing)) throw new ArchiveFormatError('订阅列表格式无效');
    async function pages<T>(path: string, guard: (raw: unknown) => raw is T): Promise<T[]> {
        const items: T[] = [];
        for (let page = 1; page <= 10000; page++) {
            const data = await get(`${path}?page=${page}&limit=200`);
            if (!isArchiveRecord(data) || !Array.isArray(data.items) || !data.items.every(guard)
                || !nonnegative(data.total) || data.items.length > 200) throw new ArchiveFormatError('订阅分页格式无效');
            items.push(...data.items);
            if (items.length >= data.total) return items;
            if (!data.items.length) throw new ArchiveFormatError('订阅分页未推进，请刷新重试');
        }
        throw new ArchiveFormatError('订阅分页超过安全上限，请缩小保留范围后重试');
    }
    const [works, reports] = await Promise.all([pages('bloggers/works', isCloudWork), pages('bloggers/reports', isCloudReport)]);
    return { ...listing, works, reports, fetchedAt: nowBeijingDateTime() };
}
