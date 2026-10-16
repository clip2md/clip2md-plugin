import { resolveNoteTitle } from './note-title';
import { FileManager, requestUrl, TFile, Vault } from 'obsidian';
import { BijiSyncSettings, DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE, SyncContentMode } from './settings';
import { CLIP2MD_API_BASE_URL, CLIP2MD_MEDIA_CDN_BASE_URL } from './config';
import { resolveImagePath, savedTaskContent, sha256, type SavedSyncProof } from './saved-sync-proof';

export interface SyncAckScope {
    version: 2;
    content_mode: SyncContentMode;
    image_mode?: 'local' | 'disabled';
    required_assets: Array<{ id: number; url: string; original_url?: string | null; status: string }>;
}

export interface SyncTask {
    id: number;
    ack_token?: string | null;
    ack_scope?: SyncAckScope | null;
    url: string;
    status: string;
    title: string | null;
    display_title?: string | null;
    summary: string | null;
    note_markdown_content: string | null;
    source_markdown_content: string | null;
    note_content_version: number;
    source_content_version: number;
    source_date: string | null;
    duration_seconds: number | null;
    content_type: string | null;
    content_source: string;
    asset_count: number;
    asset_ready_count: number;
    asset_pending_count: number;
    asset_failed_count: number;
    assets_updated_at: string | null;
    created_at: string;
    updated_at: string;
    source_title: string | null;
    source_description: string | null;
    tags?: Array<{ id: number; name: string; source: 'AI' | 'USER'; upstream_type: string }>;
}

interface TaskFileMapping {
    [taskId: number]: string;
}

export interface SyncResult {
    filepath: string | null;
    skipped: boolean;
    reason?: string;
    ignoredLocally?: boolean;
    pendingAssets?: boolean;
    failedAssets?: boolean;
    localizedAssetCount?: number;
    unlocalizedImages?: boolean;
    warning?: string;
    selectedContentWritten?: boolean;
    verifiedAssetIds?: number[];
    imageErrors?: string[];
    savedProof?: SavedSyncProof;
    imagesOmitted?: boolean;
}

const DAILY_FRONTMATTER_MARKER = '<!-- clip2md-daily-frontmatter:v1 -->';
const DAILY_BLOCK_PATTERN = /<!-- clip2md-task-start:(\d+) -->([\s\S]*?)<!-- clip2md-task-end:\1 -->/g;

interface DailyTaskMetadata {
    id: number;
    title: string;
    url?: string;
    tags?: string[];
}

export function validateMarkdownBodyTemplate(template: string): { valid: boolean; message: string } {
    if (!template.trim()) return { valid: false, message: 'Markdown 模板不能为空。' };
    if (/^\uFEFF?\s*---[ \t]*(?:\r?\n|$)/.test(template)) {
        return { valid: false, message: 'Markdown 模板不能包含开头的 frontmatter；请将 YAML 移到前置元数据模板后再同步。' };
    }
    return { valid: true, message: '' };
}

export interface SyncBatch {
    tasks: SyncTask[];
    total: number;
    nextCursor: string | null;
    hasMore: boolean;
}

export interface PendingTaskFetchResult {
    taskId: number;
    task: SyncTask | null;
    missing: boolean;
}

export interface TemplatePreviewData {
    folder: string;
    filename: string;
}

export class SyncRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'SyncRequestError';
    }
}

export function isInvalidApiKeyError(error: unknown): boolean {
    return error instanceof SyncRequestError && error.status === 401;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isSyncTask(value: unknown): value is SyncTask {
    if (!isRecord(value)) return false;

    const numberFields = [
        'id', 'note_content_version', 'source_content_version', 'asset_count',
        'asset_ready_count', 'asset_pending_count', 'asset_failed_count',
    ];
    const stringFields = ['url', 'status', 'content_source', 'created_at', 'updated_at'];
    const nullableStringFields = [
        'title', 'summary', 'note_markdown_content', 'source_markdown_content',
        'source_date', 'content_type', 'assets_updated_at', 'source_title', 'source_description',
    ];

    return numberFields.every(field => typeof value[field] === 'number')
        && stringFields.every(field => typeof value[field] === 'string')
        && nullableStringFields.every(field => isNullableString(value[field]))
        && (value.display_title === undefined || isNullableString(value.display_title))
        && (value.duration_seconds === null || typeof value.duration_seconds === 'number')
        && (value.ack_token === undefined || isNullableString(value.ack_token))
        && (value.ack_scope == null || (isRecord(value.ack_scope)
            && value.ack_scope.version === 2
            && ['full', 'note', 'source'].includes(String(value.ack_scope.content_mode))
            && (value.ack_scope.image_mode === undefined || ['local', 'disabled'].includes(String(value.ack_scope.image_mode)))
            && Array.isArray(value.ack_scope.required_assets)
            && value.ack_scope.required_assets.every(asset => isRecord(asset)
                && Number.isSafeInteger(asset.id) && Number(asset.id) > 0
                && typeof asset.url === 'string' && typeof asset.status === 'string')))
        && (value.tags === undefined || (
            Array.isArray(value.tags)
            && value.tags.every(tag => isRecord(tag)
                && typeof tag.id === 'number'
                && typeof tag.name === 'string'
                && (tag.source === 'AI' || tag.source === 'USER')
                && typeof tag.upstream_type === 'string')
        ));
}

function parseSyncTask(value: unknown): SyncTask {
    if (!isSyncTask(value)) {
        throw new Error('服务返回了格式无效的同步任务');
    }
    return value;
}

interface LocalizeResult {
    task: SyncTask;
    pendingAssets: boolean;
    failedAssets: boolean;
    localizedAssetCount: number;
    images: Array<{ url: string; path: string; id?: number }>;
    imageErrors: string[];
}

interface MarkdownImageParts {
    altText: string;
    remoteUrl: string;
    suffix: string;
}

const markdownImagePattern = () => /!\[([^\]]*)\]\((<[^>\n]+>|(?:[^\s()]|\([^()\n]*\))+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/g;

function parseMarkdownImage(whole: string): MarkdownImageParts | null {
    const match = markdownImagePattern().exec(whole);
    if (!match || match[0] !== whole) return null;
    return {
        altText: match[1],
        remoteUrl: match[2].replace(/^<|>$/g, ''),
        suffix: match[3] || '',
    };
}

function isManagedImageUrl(remoteUrl: string): boolean {
    if (remoteUrl.startsWith('/api/v1/assets/')) {
        return true;
    }

    try {
        const parsed = new URL(remoteUrl);
        const mediaCdn = new URL(CLIP2MD_MEDIA_CDN_BASE_URL);
        return parsed.protocol === mediaCdn.protocol
            && parsed.host === mediaCdn.host
            && parsed.pathname.startsWith('/assets/');
    } catch {
        return false;
    }
}

function stableImageIdentity(remoteUrl: string): string {
    try {
        const parsed = new URL(remoteUrl, CLIP2MD_API_BASE_URL);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return remoteUrl.replace(/[?#].*$/, '');
    }
}

function apiAssetId(remoteUrl: string): number | null {
    try {
        const url = new URL(remoteUrl, CLIP2MD_API_BASE_URL);
        if (url.origin !== new URL(CLIP2MD_API_BASE_URL).origin) return null;
        const match = /^\/api\/v1\/assets\/(\d+)$/.exec(url.pathname);
        return match ? Number(match[1]) : null;
    } catch { return null; }
}

function hasUnlocalizedImages(markdown: string | null): boolean {
    if (!markdown) return false;
    // These syntaxes are not handled by localizeTaskImages. A false positive
    // only keeps the source task; a false negative could delete its images.
    return /<img\b/i.test(markdown)
        || /!\[[^\]]*\]\[[^\]]*\]/.test(markdown)
        || /!\[[^\]]*\]\(\s*<?(?:https?:\/\/|\/\/|\/api\/v1\/assets\/)/i.test(markdown)
        || markdown.includes('/api/v1/assets/')
        || markdown.includes(`${CLIP2MD_MEDIA_CDN_BASE_URL}/assets/`);
}

function imageExtension(bytes: ArrayBuffer): 'png' | 'jpg' | 'gif' | 'webp' | 'avif' | null {
    const data = new Uint8Array(bytes);
    const ascii = (start: number, end: number) => String.fromCharCode(...data.slice(start, end));
    if (data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte)) {
        return 'png';
    }
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'jpg';
    }
    if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
        return 'gif';
    }
    if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
        return 'webp';
    }
    if (data.length >= 16 && ascii(4, 8) === 'ftyp'
        && (ascii(8, 12) === 'avif' || ascii(8, 12) === 'avis')) {
        return 'avif';
    }
    return null;
}

export class SyncService {
    private settings: BijiSyncSettings;
    private fileManager: FileManager | null;
    private cursor: string | null = null;
    private taskFileMap: TaskFileMapping = {};
    private pendingTaskIds: number[] = [];
    private ignoredTaskIds = new Set<number>();
    private warnedUnmanagedDailyPaths = new Set<string>();

    constructor(settings: BijiSyncSettings, fileManager?: FileManager) {
        this.settings = settings;
        this.fileManager = fileManager || null;
    }

    updateSettings(settings: BijiSyncSettings) {
        this.settings = settings;
    }

    setCursor(cursor: string | null) {
        this.cursor = cursor;
    }

    getCursor(): string | null {
        return this.cursor;
    }

    loadPendingTaskIds(ids: number[]) {
        this.pendingTaskIds = Array.from(new Set(ids || []))
            .filter(id => !this.settings.preventReimportAfterLocalRemoval || !this.ignoredTaskIds.has(id));
    }

    getPendingTaskIds(): number[] {
        return this.pendingTaskIds;
    }

    markPending(taskId: number) {
        if (this.settings.preventReimportAfterLocalRemoval && this.ignoredTaskIds.has(taskId)) {
            return;
        }
        if (!this.pendingTaskIds.includes(taskId)) {
            this.pendingTaskIds.push(taskId);
        }
    }

    removePending(taskId: number) {
        this.pendingTaskIds = this.pendingTaskIds.filter(id => id !== taskId);
    }

    markComplete(taskId: number) {
        this.pendingTaskIds = this.pendingTaskIds.filter(id => id !== taskId);
    }

    loadTaskFileMap(mapping: TaskFileMapping) {
        this.taskFileMap = mapping || {};
    }

    getTaskFileMap(): TaskFileMapping {
        return this.taskFileMap;
    }

    loadIgnoredTaskIds(ids: number[]) {
        this.ignoredTaskIds = new Set((ids || []).filter(id => Number.isSafeInteger(id) && id > 0));
        this.pendingTaskIds = this.pendingTaskIds.filter(id => !this.ignoredTaskIds.has(id));
    }

    getIgnoredTaskIds(): number[] {
        return [...this.ignoredTaskIds];
    }

    markIgnored(taskId: number) {
        this.ignoredTaskIds.add(taskId);
        this.removePending(taskId);
    }

    removeIgnored(taskId: number) {
        this.ignoredTaskIds.delete(taskId);
    }

    async verifyTaskFile(vault: Vault, taskId: number): Promise<boolean> {
        const mappedPath = this.taskFileMap[taskId];
        if (!mappedPath) return false;
        const file = vault.getFileByPath(mappedPath);
        if (!file) return false;
        const content = await vault.read(file);
        return this.hasMappedTaskMarker(content, taskId);
    }

    async findMissingMappedTaskIds(vault: Vault): Promise<number[]> {
        const missing: number[] = [];
        for (const key of Object.keys(this.taskFileMap)) {
            const taskId = Number(key);
            if (Number.isSafeInteger(taskId) && taskId > 0 && !await this.verifyTaskFile(vault, taskId)) {
                missing.push(taskId);
            }
        }
        return missing;
    }

    async probeConnection(): Promise<void> {
        await this.fetchTasksPage(null, 1);
    }

    async fetchPendingTasks(): Promise<PendingTaskFetchResult[]> {
        return this.fetchTasksByIds(this.pendingTaskIds);
    }

    async fetchIgnoredTasks(): Promise<PendingTaskFetchResult[]> {
        return this.fetchTasksByIds(this.getIgnoredTaskIds());
    }

    async fetchTasksByIds(taskIds: number[]): Promise<PendingTaskFetchResult[]> {
        const ids = [...new Set(taskIds)].filter(id => Number.isSafeInteger(id) && id > 0);
        const results: PendingTaskFetchResult[] = [];
        for (let offset = 0; offset < ids.length; offset += 5) {
            const batch = await Promise.all(ids.slice(offset, offset + 5).map(async (taskId) => {
                try {
                    const response = await requestUrl({
                        url: `${CLIP2MD_API_BASE_URL}/sync/tasks/${taskId}?sync_content_mode=${this.settings.syncContentMode}&sync_image_mode=${this.settings.imageMode}`,
                        method: 'GET',
                        headers: { 'X-API-Key': this.settings.apiKey },
                        throw: false,
                    });
                    if (response.status === 404) {
                        return { taskId, task: null, missing: true };
                    }
                    if (response.status < 200 || response.status >= 300) {
                        throw this.buildRequestError(response.status);
                    }
                    return {
                        taskId,
                        task: parseSyncTask(response.json as unknown),
                        missing: false,
                    };
                } catch (error) {
                    const friendly = this.normalizeRequestError(error);
                    friendly.message = `同步任务 ${taskId}: ${friendly.message}`;
                    throw friendly;
                }
            }));
            results.push(...batch);
        }

        return results
            .map(item => ({
                ...item,
                task: item.task && this.hasSyncableContent(item.task) ? item.task : null,
            }));
    }

    async fetchNextPage(cursor: string | null): Promise<SyncBatch> {
        return this.fetchTasksPage(cursor, 100);
    }

    createPreviewTask(): SyncTask {
        return {
            id: 9527,
            url: 'https://clip2.md/example',
            status: 'SUCCESS',
            title: 'Clip2MD 使用示例',
            display_title: '网站展示标题',
            summary: '示例摘要',
            note_markdown_content: '## 智能笔记\n\n这是智能笔记示例。',
            source_markdown_content: '# 原文标题\n\n这是原文内容示例。',
            note_content_version: 1,
            source_content_version: 1,
            source_date: '2026-08-08T08:00:00Z',
            duration_seconds: 420,
            content_type: 'article',
            content_source: 'wechat',
            asset_count: 0,
            asset_ready_count: 0,
            asset_pending_count: 0,
            asset_failed_count: 0,
            assets_updated_at: null,
            created_at: '2026-08-08T09:30:00Z',
            updated_at: '2026-08-08T09:30:00Z',
            source_title: '示例原文',
            source_description: '示例描述',
            tags: [
                { id: 1, name: '示例', source: 'USER', upstream_type: 'manual' },
                { id: 2, name: '知识管理', source: 'AI', upstream_type: 'topic' },
            ],
        };
    }

    getTemplatePreviewData(): TemplatePreviewData {
        const task = this.createPreviewTask();
        return {
            folder: this.resolveFolderPath(task, this.settings.targetFolder || 'Clip2MD'),
            filename: this.generateFilename(task),
        };
    }

    renderTemplatePreview(template: string, target?: 'single' | 'daily'): string {
        const task = this.createPreviewTask();
        const body = this.renderBodyTemplate(template, task);
        if (target === 'daily' || (!target && this.shouldMergeDaily(task))) {
            let block = this.buildMergeBlock(task.id, this.getNoteTitle(task), body, task);
            if (target === 'daily') {
                const second = { ...task, id: task.id + 1, title: '第二篇示例', display_title: '第二篇网站标题', url: 'https://clip2.md/example-2',
                    note_markdown_content: '这是第二篇智能笔记。', source_markdown_content: '这是第二篇原文。' };
                block += `\n\n${this.buildMergeBlock(second.id, this.getNoteTitle(second), this.renderBodyTemplate(template, second), second)}`;
            }
            const heading = `# ${this.getSourceLabel(task)} · ${this.formatDateForFilename(task.created_at)}`;
            return this.applyDailyFrontmatter(`${heading}\n\n${block}`, task).content;
        }
        return this.renderSingleTask(task, body);
    }

    renderDailyMergeFrontmatterPreview(): string {
        const task = this.createPreviewTask();
        const block = this.buildMergeBlock(task.id, task.title || '', '', task);
        return this.renderDailyFrontmatter(block, task);
    }

    validateTemplate(template: string): { valid: boolean; message: string } {
        return validateMarkdownBodyTemplate(template);
    }

    validateTargetFolder(folder: string): boolean {
        const rawSegments = (folder || 'Clip2MD').replace(/\\/g, '/').split('/');
        if (rawSegments.some(segment => segment.trim() === '..')) {
            return false;
        }
        const resolved = this.normalizePathTemplate(folder || 'Clip2MD');
        return resolved.length > 0 && !resolved.split('/').some(segment => segment === '..');
    }

    async renderToVault(
        vault: Vault,
        task: SyncTask,
        folderTemplate: string,
        template: string,
    ): Promise<SyncResult> {
        // Freeze the content settings while downloads and Vault writes await I/O.
        const settings = { ...this.settings };
        const writer = new SyncService(settings, this.fileManager ?? undefined);
        writer.taskFileMap = this.taskFileMap;
        writer.ignoredTaskIds = this.ignoredTaskIds;
        writer.pendingTaskIds = this.pendingTaskIds;
        writer.warnedUnmanagedDailyPaths = this.warnedUnmanagedDailyPaths;
        try {
            return await writer.writeTaskToVault(vault, task, folderTemplate, template);
        } finally {
            this.pendingTaskIds = writer.pendingTaskIds;
        }
    }

    private async writeTaskToVault(vault: Vault, task: SyncTask, folderTemplate: string, template: string): Promise<SyncResult> {
        const validation = this.validateTemplate(template);
        if (!validation.valid) throw new Error(validation.message);
        const mappedPath = this.taskFileMap[task.id];
        const wasIgnored = this.ignoredTaskIds.has(task.id);
        const protectLocalRemoval = this.settings.preventReimportAfterLocalRemoval;
        if (protectLocalRemoval && wasIgnored) {
            return this.ignoredResult(task.id);
        }
        const mappedFilePresent = mappedPath ? await this.verifyTaskFile(vault, task.id) : false;
        if (protectLocalRemoval && mappedPath && !mappedFilePresent) {
            this.markIgnored(task.id);
            return this.ignoredResult(task.id);
        }
        const restoring = Boolean(wasIgnored || (mappedPath && !mappedFilePresent));
        const folder = this.resolveFolderPath(task, folderTemplate);
        const selectedTask = task.ack_scope ? {
            ...task,
            note_markdown_content: this.settings.syncContentMode === 'source' ? null : task.note_markdown_content,
            source_markdown_content: this.settings.syncContentMode === 'note' ? null : task.source_markdown_content,
        } : task;
        const referenceFolder = this.shouldMergeDaily(task) && mappedFilePresent && mappedPath
            ? mappedPath.split('/').slice(0, -1).join('/') : folder;
        const localized = await this.localizeTaskImages(vault, selectedTask, folder, referenceFolder);
        // Explicit custom template variables retain their existing meaning.
        // Only the selected fields are localized; additional remote images in
        // a custom template will be caught by the final-file verification.
        const localizedTask = task.ack_scope ? {
            ...task,
            note_markdown_content: this.settings.syncContentMode === 'source' ? task.note_markdown_content : localized.task.note_markdown_content,
            source_markdown_content: this.settings.syncContentMode === 'note' ? task.source_markdown_content : localized.task.source_markdown_content,
        } : localized.task;
        const assetResult = {
            pendingAssets: localized.pendingAssets,
            failedAssets: localized.failedAssets,
            localizedAssetCount: localized.localizedAssetCount,
            unlocalizedImages: [localizedTask.note_markdown_content, localizedTask.source_markdown_content]
                .some(hasUnlocalizedImages)
                || (this.settings.imageMode === 'disabled'
                    && [selectedTask.note_markdown_content, selectedTask.source_markdown_content]
                        .some(markdown => Boolean(markdown && (markdown.includes('![') || /<img\b/i.test(markdown))))),
        };
        let body = this.renderBodyTemplate(template, localizedTask);
        if (task.ack_scope?.image_mode === 'disabled' && this.settings.imageMode === 'disabled') body = this.stripImages(body) || '';
        const finalize = async (result: SyncResult): Promise<SyncResult> => {
            if (!task.ack_scope || result.skipped || !result.filepath) return result;
            return this.verifyWrittenTask(vault, task, selectedTask, localized, result);
        };
        if (localized.pendingAssets) {
            body = `${body}\n\n> 图片仍在处理中（任务 #${task.id}），稍后会自动重试。`;
        }
        if (localized.failedAssets) {
            body = `${body}\n\n> 部分图片下载失败（任务 #${task.id}），请在 clip2md 网站同步页重试。`;
        }

        // The note can be moved while an image request is in flight.
        if (protectLocalRemoval && mappedPath && !await this.verifyTaskFile(vault, task.id)) {
            this.markIgnored(task.id);
            return this.ignoredResult(task.id);
        }

        if (this.shouldMergeDaily(localizedTask)) {
            return finalize(await this.renderMergedTask(vault, localizedTask, folder, body, assetResult, restoring));
        }

        const content = this.renderSingleTask(localizedTask, body);

        const filename = this.generateFilename(localizedTask);
        const filepath = `${folder}/${filename}`;

        await this.ensureFolder(vault, folder);

        if (mappedPath) {
            const mappedFile = vault.getFileByPath(mappedPath);
            if (mappedFile) {
                const fileContent = await vault.read(mappedFile);
                if (this.hasTaskMarker(fileContent, task.id)) {
                    if (mappedPath !== filepath) {
                        const existingTarget = vault.getAbstractFileByPath(filepath);
                        if (existingTarget) {
                            if (!(existingTarget instanceof TFile)) {
                                return {
                                    filepath: null,
                                    skipped: true,
                                    reason: `目标路径 ${filename} 已被文件夹占用，已跳过`,
                                };
                            }
                            const targetContent = await vault.read(existingTarget);
                            if (this.hasTaskMarker(targetContent, task.id)) {
                                await vault.modify(existingTarget, content);
                                try {
                                    if (!this.fileManager) {
                                        throw new Error('FileManager unavailable');
                                    }
                                    await this.fileManager.trashFile(mappedFile);
                                } catch (error) {
                                    console.warn(`Clip2MD: 清理旧文件失败 ${mappedPath}: ${String(error)}`);
                                }
                                this.taskFileMap[task.id] = filepath;
                                return finalize(this.completedResult(task.id, filepath, assetResult));
                            }
                            return {
                                filepath: null,
                                skipped: true,
                                reason: `目标文件 ${filename} 已存在且不含任务标记，无法重命名，已跳过`,
                            };
                        }
                        await vault.rename(mappedFile, filepath);
                    }
                    const targetFile = vault.getFileByPath(filepath);
                    if (!targetFile) {
                        throw new Error(`无法定位同步文件 ${filepath}`);
                    }
                    await vault.modify(targetFile, content);
                    this.taskFileMap[task.id] = filepath;
                    return finalize(this.completedResult(task.id, filepath, assetResult));
                }
            }
            delete this.taskFileMap[task.id];
        }

        const existingFile = vault.getFileByPath(filepath);
        if (existingFile) {
            const fileContent = await vault.read(existingFile);
            if (this.hasTaskMarker(fileContent, task.id)) {
                await vault.modify(existingFile, content);
                this.taskFileMap[task.id] = filepath;
                return finalize(this.completedResult(task.id, filepath, assetResult));
            }
            if (!restoring) {
                return {
                    filepath: null,
                    skipped: true,
                    reason: `文件 ${filename} 已存在且不含任务标记，已跳过`,
                };
            }
        }

        const createPath = this.nextAvailableMarkdownPath(vault, filepath);

        await vault.create(createPath, content);
        this.taskFileMap[task.id] = createPath;
        return finalize(this.completedResult(task.id, createPath, assetResult));
    }

    private async verifyWrittenTask(vault: Vault, task: SyncTask, selectedTask: SyncTask, localized: LocalizeResult, result: SyncResult): Promise<SyncResult> {
        const filepath = result.filepath!;
        const file = vault.getAbstractFileByPath(filepath);
        if (!(file instanceof TFile)) return { ...result, selectedContentWritten: false };
        const content = savedTaskContent(await vault.read(file), task.id);
        const selectedBodies = [selectedTask.note_markdown_content, selectedTask.source_markdown_content].filter(value => Boolean(value?.trim()));
        const localizedBodies = [localized.task.note_markdown_content, localized.task.source_markdown_content].filter(value => Boolean(value?.trim()));
        const selectedContentWritten = selectedBodies.length > 0 && localizedBodies.length === selectedBodies.length
            && localizedBodies.every(value => content.includes(value!));
        if (task.ack_scope?.image_mode === 'disabled' && this.settings.imageMode === 'disabled') {
            return {
                ...result, selectedContentWritten, verifiedAssetIds: [], imageErrors: [],
                imagesOmitted: true, unlocalizedImages: false,
                savedProof: { filepath, contentHash: await sha256(content), images: [] },
            };
        }
        const imageErrors = [...localized.imageErrors];
        if (this.settings.imageMode === 'disabled'
            && [selectedTask.note_markdown_content, selectedTask.source_markdown_content].some(value => value && /!\[|<img\b/i.test(value))) {
            imageErrors.push('所选正文含图片，但图片未设置为本地保存');
        }
        const verifiedAssetIds = new Set<number>();
        const images: SavedSyncProof['images'] = [];
        // HTML, reference and wiki images need a parser-specific mapping; withhold
        // receipts until supported rather than infer success from a file count.
        if (/<img\b|!\[[^\]]*\]\[[^\]]*\]|!\[\[/i.test(content)) {
            imageErrors.push('正文含暂不支持核验的 HTML、引用式或 Wiki 图片，请使用 Markdown 行内图片');
        }
        const refs = [...content.matchAll(markdownImagePattern())];
        if ((content.match(/!\[/g) || []).length !== refs.length) {
            imageErrors.push('正文含无法解析的图片引用，请检查图片语法');
        }
        for (const match of refs) {
            const reference = match[2];
            const path = resolveImagePath(filepath, reference);
            if (!path) {
                imageErrors.push(`图片 ${reference}：仍为远程引用或路径无效`);
                continue;
            }
            const image = vault.getAbstractFileByPath(path);
            if (!(image instanceof TFile)) {
                imageErrors.push(`图片 ${reference} → ${path}：附件不存在`);
                continue;
            }
            try {
                const bytes = await vault.readBinary(image);
                if (!imageExtension(bytes)) throw new Error('附件为空或图片格式无效');
                images.push({ path, hash: await sha256(bytes) });
                for (const saved of localized.images) {
                    if (saved.path === path && saved.id !== undefined) verifiedAssetIds.add(saved.id);
                }
            } catch (error) {
                imageErrors.push(`图片 ${reference} → ${path}：${String(error)}`);
            }
        }
        for (const asset of task.ack_scope!.required_assets) {
            if (asset.status !== 'READY' || !verifiedAssetIds.has(asset.id)) {
                imageErrors.push(`图片 #${asset.id} (${asset.url})：${asset.status !== 'READY' ? `服务端状态 ${asset.status}` : '未在正文中找到已核验的本地附件'}`);
            }
        }
        // A text link to a hosted attachment would also break after cleanup.
        if (content.includes('/api/v1/assets/') || content.includes(`${CLIP2MD_MEDIA_CDN_BASE_URL}/assets/`)) {
            imageErrors.push('正文仍包含未保存到本地的托管素材引用');
        }
        return {
            ...result, selectedContentWritten, verifiedAssetIds: [...verifiedAssetIds].sort((a, b) => a - b), imageErrors,
            unlocalizedImages: imageErrors.length > 0,
            savedProof: { filepath, contentHash: await sha256(content), images },
        };
    }

    private ignoredResult(taskId: number): SyncResult {
        return {
            filepath: null,
            skipped: true,
            ignoredLocally: true,
            reason: `任务 ${taskId} 的原同步内容已在当前 Vault 删除或移走，已按设置忽略`,
        };
    }

    private completedResult(
        taskId: number,
        filepath: string,
        assetResult: Pick<SyncResult, 'pendingAssets' | 'failedAssets' | 'localizedAssetCount' | 'unlocalizedImages'>,
    ): SyncResult {
        if (!assetResult.pendingAssets && !assetResult.failedAssets) {
            this.removeIgnored(taskId);
        }
        return { filepath, skipped: false, ...assetResult };
    }

    private nextAvailableMarkdownPath(vault: Vault, filepath: string): string {
        let candidate = filepath;
        let suffix = 2;
        while (vault.getAbstractFileByPath(candidate)) {
            candidate = `${filepath.slice(0, -3)} ${suffix}.md`;
            suffix += 1;
        }
        return candidate;
    }

    private async fetchTasksPage(cursor: string | null, limit: number): Promise<SyncBatch> {
        const params = new URLSearchParams({ limit: String(limit), sync_content_mode: this.settings.syncContentMode, sync_image_mode: this.settings.imageMode });
        if (cursor) {
            params.set('cursor', cursor);
        }
        const response = await requestUrl({
            url: `${CLIP2MD_API_BASE_URL}/sync/tasks?${params.toString()}`,
            method: 'GET',
            headers: { 'X-API-Key': this.settings.apiKey },
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw this.buildRequestError(response.status);
        }

        const body = response.json as unknown;
        if (!isRecord(body) || !Array.isArray(body.items)) {
            throw new Error('服务返回了格式无效的同步任务列表');
        }
        const items = body.items.map(item => parseSyncTask(item));
        return {
            tasks: items.filter(task => this.hasSyncableContent(task)),
            total: typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : items.length,
            nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
            hasMore: body.has_more === true,
        };
    }

    private hasSyncableContent(task: SyncTask): boolean {
        return Boolean(task.note_markdown_content || task.source_markdown_content);
    }

    private async renderMergedTask(
        vault: Vault,
        task: SyncTask,
        folder: string,
        content: string,
        assetResult: Pick<SyncResult, 'pendingAssets' | 'failedAssets' | 'localizedAssetCount' | 'unlocalizedImages'>,
        restoring: boolean,
    ): Promise<SyncResult> {
        await this.ensureFolder(vault, folder);
        const mergedFilename = `${this.formatDateForFilename(task.created_at)}-${this.getSourceLabel(task)}.md`;
        const targetPath = `${folder}/${this.sanitizeFilenameSegment(mergedFilename)}`;
        const block = this.buildMergeBlock(task.id, this.getNoteTitle(task), content, task);
        const mappedPath = this.taskFileMap[task.id];
        const mappedFile = mappedPath ? vault.getFileByPath(mappedPath) : null;
        if (mappedFile) {
            const mappedContent = await vault.read(mappedFile);
            if (this.hasMergeBlock(mappedContent, task.id)) {
                const next = this.applyDailyFrontmatter(this.upsertMergeBlock(mappedContent, task.id, block), task);
                await vault.modify(mappedFile, next.content);
                return { ...this.completedResult(task.id, mappedPath, assetResult), warning: this.dailyWarning(mappedPath, next.warning) };
            }
        }
        let filepath = targetPath;
        let existing = vault.getFileByPath(filepath);

        if (restoring && vault.getAbstractFileByPath(filepath)) {
            const existingContent = existing ? await vault.read(existing) : '';
            if (!this.isManagedDailyFile(existingContent)) {
                filepath = this.nextAvailableMarkdownPath(vault, filepath);
                existing = null;
            }
        }

        if (!existing) {
            const initial = `# ${this.getSourceLabel(task)} · ${this.formatDateForFilename(task.created_at)}\n\n${block}`;
            await vault.create(filepath, this.applyDailyFrontmatter(initial, task).content);
            this.taskFileMap[task.id] = filepath;
            return this.completedResult(task.id, filepath, assetResult);
        }

        const existingContent = await vault.read(existing);
        const next = this.applyDailyFrontmatter(this.upsertMergeBlock(existingContent, task.id, block), task);
        await vault.modify(existing, next.content);
        this.taskFileMap[task.id] = filepath;
        return { ...this.completedResult(task.id, filepath, assetResult), warning: this.dailyWarning(filepath, next.warning) };
    }

    private dailyWarning(path: string, warning?: string): string | undefined {
        if (!warning || this.warnedUnmanagedDailyPaths.has(path)) return undefined;
        this.warnedUnmanagedDailyPaths.add(path);
        return `${path}：${warning}`;
    }

    private applyDailyFrontmatter(content: string, task: SyncTask): { content: string; warning?: string } {
        const frontmatter = this.renderDailyFrontmatter(content, task);
        const managed = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n<!-- clip2md-daily-frontmatter:v1 -->/;
        if (managed.test(content)) {
            return { content: content.replace(managed, () => `${frontmatter}\n${DAILY_FRONTMATTER_MARKER}`) };
        }
        if (/^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(content)) {
            return { content, warning: '文件顶部已有手写 frontmatter，已保留；请手动迁移后使用按日合并元数据模板。' };
        }
        return { content: `${frontmatter}\n${DAILY_FRONTMATTER_MARKER}\n\n${content}` };
    }

    private renderDailyFrontmatter(content: string, task: SyncTask): string {
        const tasks = this.collectDailyTasks(content);
        const tags = [...new Set(tasks.flatMap(item => item.tags || []))];
        const fileHeading = content.match(/^# (.+) · (\d{4}-\d{2}-\d{2})$/m);
        const date = fileHeading?.[2] || this.formatDateForFilename(task.created_at);
        const source = fileHeading?.[1] || this.getSourceLabel(task);
        const yamlTasks = tasks.flatMap(item => [
            `  - id: ${item.id}`,
            ...(item.title ? [`    title: ${JSON.stringify(item.title)}`] : []),
            ...(item.url ? [`    url: ${JSON.stringify(item.url)}`] : []),
        ]).join('\n') || '  []';
        return this.replaceTemplateVariables(this.settings.dailyMergeFrontmatterTemplate || DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE, {
            '{{title}}': JSON.stringify(`${source} · ${date}`).slice(1, -1),
            '{{date}}': date,
            '{{source}}': JSON.stringify(source).slice(1, -1),
            '{{tags}}': JSON.stringify(tags),
            '{{task_count}}': String(tasks.length),
            '{{task_ids}}': JSON.stringify(tasks.map(item => item.id)),
            '{{tasks}}': yamlTasks,
        }).trimEnd();
    }

    private collectDailyTasks(content: string): DailyTaskMetadata[] {
        const tasks: DailyTaskMetadata[] = [];
        const seen = new Set<number>();
        const pattern = new RegExp(DAILY_BLOCK_PATTERN.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const id = Number(match[1]);
            if (!Number.isSafeInteger(id) || seen.has(id)) continue;
            seen.add(id);
            const block = match[2];
            const heading = block.match(/^\s*## (.+)$/m)?.[1] || '';
            const encoded = block.match(new RegExp(`^\\s*<!-- clip2md-task-meta:${id}:([^\\s]+) -->`, 'm'))?.[1];
            let metadata: Partial<DailyTaskMetadata> = {};
            if (encoded) {
                try {
                    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
                    if (isRecord(parsed)) {
                        metadata = {
                            title: typeof parsed.title === 'string' ? parsed.title : heading,
                            url: typeof parsed.url === 'string' ? parsed.url : undefined,
                            tags: Array.isArray(parsed.tags) && parsed.tags.every(tag => typeof tag === 'string')
                                ? parsed.tags : undefined,
                        };
                    }
                } catch { /* Historical or edited blocks retain their visible heading. */ }
            }
            tasks.push({ id, title: metadata.title || heading, url: metadata.url, tags: metadata.tags });
        }
        return tasks;
    }

    private isManagedDailyFile(content: string): boolean {
        return /<!-- clip2md-task-start:\d+ -->/.test(content);
    }

    private hasMergeBlock(content: string, taskId: number): boolean {
        return new RegExp(
            `<!-- clip2md-task-start:${taskId} -->[\\s\\S]*?<!-- clip2md-task-end:${taskId} -->`,
        ).test(content);
    }

    private buildMergeBlock(taskId: number, title: string, content: string, task: SyncTask): string {
        const metadata = encodeURIComponent(JSON.stringify({
            title,
            url: task.url || undefined,
            tags: task.tags?.map(tag => tag.name) || [],
        }));
        return [
            `<!-- clip2md-task-start:${taskId} -->`,
            `<!-- clip2md-task-meta:${taskId}:${metadata} -->`,
            `## ${title}`,
            '',
            content,
            `<!-- clip2md-task-end:${taskId} -->`,
        ].join('\n');
    }

    private upsertMergeBlock(existing: string, taskId: number, block: string): string {
        const pattern = new RegExp(
            `<!-- clip2md-task-start:${taskId} -->[\\s\\S]*?<!-- clip2md-task-end:${taskId} -->`,
            'm',
        );
        if (pattern.test(existing)) {
            return existing.replace(pattern, () => block);
        }
        const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
        return `${existing}${separator}${block}\n`;
    }

    private shouldMergeDaily(task: SyncTask): boolean {
        if (this.settings.mergeMode !== 'daily') {
            return false;
        }
        const source = (task.content_source || '').toLowerCase();
        return ['wechat', 'qq', 'email'].some(item => source.includes(item));
    }

    private async localizeTaskImages(
        vault: Vault,
        task: SyncTask,
        folder: string,
        referenceFolder = folder,
    ): Promise<LocalizeResult> {
        if (this.settings.imageMode === 'disabled') {
            return {
                task: {
                    ...task,
                    note_markdown_content: this.stripImages(task.note_markdown_content),
                    source_markdown_content: this.stripImages(task.source_markdown_content),
                },
                pendingAssets: false,
                failedAssets: false,
                localizedAssetCount: 0,
                images: [], imageErrors: [],
            };
        }

        const configuredImageFolder = this.settings.imageFolder?.trim() || '';
        const imageBaseFolder = configuredImageFolder
            ? configuredImageFolder === '/' ? '' : this.normalizePathTemplate(configuredImageFolder)
            : `${folder}/_assets`;
        const imageFolder = imageBaseFolder
            ? `${imageBaseFolder}/task-${task.id}`
            : `task-${task.id}`;
        let imageFolderReady = false;
        let pendingAssets = false;
        let failedAssets = false;
        const localizedAssets = new Set<string>();
        const images: LocalizeResult['images'] = [];
        const imageErrors: string[] = [];
        const downloaded = new Map<string, string>();

        const localize = async (markdown: string | null): Promise<string | null> => {
            if (!markdown) {
                return markdown;
            }
            const regex = markdownImagePattern();
            const replacements = new Map<string, string | null>();
            const imageMatches: MarkdownImageParts[] = [];
            markdown.replace(regex, (whole: string) => {
                const parsed = parseMarkdownImage(whole);
                if (parsed) {
                    imageMatches.push(parsed);
                }
                return whole;
            });
            for (const { remoteUrl } of imageMatches) {
                const asset = task.ack_scope?.required_assets.find(item => stableImageIdentity(item.url) === stableImageIdentity(remoteUrl)
                    || item.original_url === remoteUrl
                    || apiAssetId(remoteUrl) === item.id);
                if (!isManagedImageUrl(remoteUrl) && !asset) {
                    continue;
                }
                if (replacements.has(remoteUrl)) {
                    continue;
                }

                try {
                    const identity = asset ? `asset:${asset.id}` : stableImageIdentity(remoteUrl);
                    const cachedPath = downloaded.get(identity);
                    if (cachedPath) {
                        replacements.set(remoteUrl, this.relativeImageUrl(referenceFolder, cachedPath));
                        continue;
                    }
                    const downloadUrl = asset?.url || remoteUrl;
                    const parsedDownload = new URL(downloadUrl, CLIP2MD_API_BASE_URL);
                    const isApiAsset = parsedDownload.origin === new URL(CLIP2MD_API_BASE_URL).origin
                        && parsedDownload.pathname.startsWith('/api/v1/assets/');
                    const response = await requestUrl({
                        url: parsedDownload.toString(),
                        method: 'GET',
                        headers: isApiAsset ? { 'X-API-Key': this.settings.apiKey } : {},
                        throw: false,
                    });
                    if (response.status < 200 || response.status >= 300) {
                        pendingAssets = true;
                        imageErrors.push(`图片 ${remoteUrl} → ${imageFolder}：下载失败 (HTTP ${response.status})`);
                        replacements.set(remoteUrl, null);
                        continue;
                    }
                    const responseType = this.getResponseHeader(response.headers, 'content-type');
                    const assetStatus = this.getResponseHeader(response.headers, 'x-asset-status')
                        || (responseType.startsWith('image/') && !responseType.includes('svg') ? 'READY' : 'PENDING');
                    if (assetStatus === 'PENDING' || assetStatus === 'PROCESSING') {
                        pendingAssets = true;
                        imageErrors.push(`图片 ${remoteUrl} → ${imageFolder}：仍在处理中 (${assetStatus})`);
                        replacements.set(remoteUrl, null);
                        continue;
                    }
                    if (assetStatus === 'FAILED') {
                        failedAssets = true;
                        imageErrors.push(`图片 ${remoteUrl} → ${imageFolder}：服务端保存失败`);
                        replacements.set(remoteUrl, null);
                        continue;
                    }

                    const bytes = response.arrayBuffer;
                    const extension = imageExtension(bytes);
                    if (!extension) {
                        pendingAssets = true;
                        imageErrors.push(`图片 ${remoteUrl} → ${imageFolder}：图片为空或格式无效`);
                        replacements.set(remoteUrl, null);
                        continue;
                    }
                    const safeName = `${this.hash(identity)}.${extension}`;
                    const path = `${imageFolder}/${safeName}`;
                    if (!imageFolderReady) {
                        await this.ensureFolder(vault, imageFolder);
                        imageFolderReady = true;
                    }
                    const existingImage = vault.getAbstractFileByPath(path);
                    if (existingImage && !(existingImage instanceof TFile)) {
                        throw new Error(`图片路径 ${path} 已被文件夹占用`);
                    }
                    if (!existingImage) {
                        await vault.createBinary(path, bytes);
                    } else {
                        // A filename alone is not identity proof. Compare with
                        // the freshly fetched asset before reusing local bytes.
                        const same = task.ack_scope && await sha256(await vault.readBinary(existingImage)) === await sha256(bytes);
                        if (!same) await vault.modifyBinary(existingImage, bytes);
                    }
                    localizedAssets.add(stableImageIdentity(remoteUrl));
                    downloaded.set(identity, path);
                    images.push({ url: remoteUrl, path, id: asset?.id });
                    replacements.set(remoteUrl, this.relativeImageUrl(referenceFolder, path));
                } catch (error) {
                    pendingAssets = true;
                    replacements.set(remoteUrl, null);
                    console.warn(`Clip2MD: 图片下载失败 ${remoteUrl}`, error);
                    imageErrors.push(`图片 ${remoteUrl} → ${imageFolder}：${String(error)}`);
                }
            }

            return markdown.replace(regex, (whole: string) => {
                const parsed = parseMarkdownImage(whole);
                if (!parsed) return whole;
                const { altText, remoteUrl, suffix } = parsed;
                if (!replacements.has(remoteUrl)) {
                    return whole;
                }
                const localUrl = replacements.get(remoteUrl);
                if (!localUrl) {
                    return '';
                }
                return `![${altText}](${localUrl}${suffix})`;
            });
        };

        return {
            task: {
                ...task,
                note_markdown_content: await localize(task.note_markdown_content),
                source_markdown_content: await localize(task.source_markdown_content),
            },
            pendingAssets,
            failedAssets,
            localizedAssetCount: localizedAssets.size,
            images, imageErrors,
        };
    }

    private stripImages(markdown: string | null): string | null {
        if (!markdown) {
            return markdown;
        }
        // Preserve image syntax used as code or an escaped example. Keeping
        // offsets lets us remove image nodes without rewriting other text.
        let masked = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, match => match.replace(/[^\n]/g, ' '));
        masked = masked.replace(/(`+)[^\n]*?\1/g, match => ' '.repeat(match.length));
        const ranges: Array<[number, number]> = [];
        const labels = new Set<string>();
        const definitions = new Set([...masked.matchAll(/^ {0,3}\[([^\]]+)\]:[^\n]*/gm)].map(match => match[1].trim().toLowerCase()));
        for (const pattern of [markdownImagePattern(), /<img\b[^>]*>/gi, /!\[\[[^\]]*\]\]/g]) {
            for (const match of masked.matchAll(pattern)) {
                if (match.index! > 0 && masked[match.index! - 1] === '\\') continue;
                ranges.push([match.index!, match.index! + match[0].length]);
            }
        }
        for (const match of masked.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?/g)) {
            const label = (match[2] || match[1]).trim().toLowerCase();
            if (!definitions.has(label) || masked[match.index! + match[0].length] === '(' || masked[match.index! - 1] === '\\') continue;
            labels.add(label);
            ranges.push([match.index!, match.index! + match[0].length]);
        }
        let result = markdown;
        const merged: Array<[number, number]> = [];
        for (const range of ranges.sort((a, b) => a[0] - b[0])) {
            const previous = merged[merged.length - 1];
            if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
            else merged.push([...range]);
        }
        for (const [start, end] of merged.reverse()) result = result.slice(0, start) + result.slice(end);
        // Drop image-only definitions, retaining ones also used by text links.
        const withoutDefinitions = result.replace(/^ {0,3}\[([^\]]+)\]:[^\n]*/gm, '');
        return result.replace(/^ {0,3}\[([^\]]+)\]:[^\n]*(?:\n|$)/gm, (whole: string, label: string) =>
            labels.has(label.trim().toLowerCase()) && !withoutDefinitions.toLowerCase().includes(`[${label.trim().toLowerCase()}]`) ? '' : whole);
    }

    private async ensureFolder(vault: Vault, path: string): Promise<void> {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!vault.getAbstractFileByPath(current)) {
                await vault.createFolder(current);
            }
        }
    }

    private hash(value: string): string {
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(16);
    }

    private getContentByMode(task: SyncTask): string {
        const mode: SyncContentMode = this.settings.syncContentMode;
        const noteContent = task.note_markdown_content || '';
        const sourceContent = task.source_markdown_content || '';

        if (mode === 'note') {
            return noteContent;
        }
        if (mode === 'source') {
            return sourceContent;
        }

        if (noteContent && sourceContent) {
            return `${noteContent}\n\n# 原文\n\n${sourceContent}`;
        }
        return noteContent || sourceContent;
    }

    private generateFrontmatter(task: SyncTask, title: string): string {
        const template = this.settings.frontmatterTemplate;
        const tagsValue = task.tags && task.tags.length > 0
            ? `[${task.tags.map(tag => JSON.stringify(tag.name)).join(', ')}]`
            : '[]';

        if (template && template.trim()) {
            return this.replaceTemplateVariables(template, {
                '{{note_title}}': JSON.stringify(this.getNoteTitle(task)).slice(1, -1),
                '{{title}}': title.replace(/"/g, '\\"'),
                '{{source_title}}': JSON.stringify(task.source_title || '').slice(1, -1),
                '{{source_title_or_title}}': JSON.stringify(task.source_title || task.title || `untitled-${task.id}`).slice(1, -1),
                '{{display_title}}': JSON.stringify(task.display_title || task.title || task.source_title || `untitled-${task.id}`).slice(1, -1),
                '{{source_date}}': task.source_date || '',
                '{{created_at}}': task.created_at,
                '{{source}}': this.getSourceLabel(task).replace(/"/g, '\\"'),
                '{{duration}}': task.duration_seconds ? this.formatDuration(task.duration_seconds) : '',
                '{{content_type}}': task.content_type || '',
                '{{task_id}}': String(task.id),
                '{{tags}}': tagsValue,
                '{{url}}': JSON.stringify(task.url || '').slice(1, -1),
            });
        }

        // 默认格式
        const lines: string[] = ['---'];
        lines.push(`title: ${JSON.stringify(this.getNoteTitle(task))}`);
        lines.push(`date: ${JSON.stringify(task.source_date || '')}`);
        lines.push(`created_at: "${task.created_at}"`);
        lines.push(`source: "${this.getSourceLabel(task).replace(/"/g, '\\"')}"`);
        if (task.duration_seconds) {
            lines.push(`duration: "${this.formatDuration(task.duration_seconds)}"`);
        }
        if (task.content_type) {
            lines.push(`content_type: "${task.content_type}"`);
        }
        lines.push(`tags: ${tagsValue}`);
        lines.push(`url: ${JSON.stringify(task.url || '')}`);
        lines.push(`task_id: ${task.id}`);
        lines.push('---');
        return lines.join('\n');
    }

    private formatDuration(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) {
            return `${h}h${m}m`;
        }
        return `${m}m`;
    }

    private getNoteTitle(task: SyncTask): string {
        return resolveNoteTitle(this.settings, task, this.getSourceLabel(task), this.formatDateForFilename(task.created_at));
    }

    private renderSingleTask(task: SyncTask, body: string): string {
        const title = task.title || this.extractTitle(task.note_markdown_content || task.source_markdown_content || '');
        const frontmatter = this.generateFrontmatter(task, title);
        const marker = `<!-- biji-task-id:${task.id} -->`;
        return [frontmatter, marker, body].filter(Boolean).join('\n\n');
    }

    private renderBodyTemplate(template: string, task: SyncTask): string {
        const title = task.title || this.extractTitle(task.note_markdown_content || task.source_markdown_content || '');
        const noteContent = task.note_markdown_content || '';
        const sourceContent = task.source_markdown_content || '';
        const content = this.getContentByMode(task);
        const tagsStr = task.tags && task.tags.length > 0 ? task.tags.map(t => t.name).join(', ') : '';

        return this.replaceTemplateVariables(template, {
            '{{note_title}}': this.getNoteTitle(task),
            '{{title}}': title,
            '{{source_title}}': task.source_title || '',
            '{{source_title_or_title}}': task.source_title || task.title || `untitled-${task.id}`,
            '{{display_title}}': task.display_title || task.title || task.source_title || `untitled-${task.id}`,
            '{{content}}': content,
            '{{note_content}}': noteContent,
            '{{source_content}}': sourceContent,
            '{{url}}': task.url,
            '{{date}}': task.source_date || '',
            '{{created_at}}': task.created_at,
            '{{created_date}}': this.formatDateForFilename(task.created_at),
            '{{source}}': this.getSourceLabel(task),
            '{{duration}}': task.duration_seconds ? this.formatDuration(task.duration_seconds) : '',
            '{{content_type}}': task.content_type || '',
            '{{task_id}}': String(task.id),
            '{{tags}}': tagsStr,
        });
    }

    private extractTitle(markdown: string): string {
        const match = markdown.match(/^#\s+(.+)$/m);
        if (match) {
            return match[1];
        }
        const firstLine = markdown.split('\n').find(line => line.trim());
        return firstLine ? firstLine.substring(0, 50) : '无标题';
    }

    private generateFilename(task: SyncTask): string {
        const resolved = this.replaceTaskVariables(this.settings.filenameTemplate || '{{created_date}}-{{title}}', task);
        const filename = this.normalizePathTemplate(resolved).split('/').filter(Boolean).pop() || '';
        const fallbackTitle = `untitled-${task.id}`;
        const safeBase = this.sanitizeFilenameSegment(filename || fallbackTitle) || fallbackTitle;
        return safeBase.endsWith('.md') ? safeBase : `${safeBase}.md`;
    }

    private resolveFolderPath(task: SyncTask, folderTemplate: string): string {
        const resolved = this.replaceTaskVariables(folderTemplate || 'Clip2MD', task);
        const normalized = this.normalizePathTemplate(resolved);
        return normalized || 'Clip2MD';
    }

    private replaceTaskVariables(template: string, task: SyncTask): string {
        const title = task.title || this.extractTitle(task.note_markdown_content || task.source_markdown_content || '') || `untitled-${task.id}`;
        const replacements: Record<string, string> = {
            '{{note_title}}': this.sanitizeFilenameSegment(this.getNoteTitle(task)),
            '{{title}}': title || `untitled-${task.id}`,
            '{{source_title}}': this.sanitizeFilenameSegment(task.source_title || ''),
            '{{source_title_or_title}}': this.sanitizeFilenameSegment(task.source_title || task.title || '') || `untitled-${task.id}`,
            '{{display_title}}': this.sanitizeFilenameSegment(task.display_title || task.title || task.source_title || '') || `untitled-${task.id}`,
            '{{date}}': task.source_date || '',
            '{{created_at}}': task.created_at,
            '{{created_date}}': this.formatDateForFilename(task.created_at),
            '{{source}}': this.getSourceLabel(task),
            '{{tags}}': task.tags?.map(tag => tag.name).join(', ') || '',
            '{{task_id}}': String(task.id),
            '{{content_type}}': task.content_type || '',
            '{{url}}': task.url,
        };

        return this.replaceTemplateVariables(template, replacements);
    }

    private replaceTemplateVariables(template: string, replacements: Record<string, string>): string {
        // Replace only the original template's tokens, keeping values literal.
        return template.replace(/\{\{[a-z_]+\}\}/g, token => (
            Object.prototype.hasOwnProperty.call(replacements, token) ? replacements[token] : token
        ));
    }

    private formatDateForFilename(dateInput: string): string {
        const date = new Date(this.normalizeDateInput(dateInput));
        const year = String(date.getFullYear());
        const month = this.padNumber(date.getMonth() + 1);
        const day = this.padNumber(date.getDate());
        const hours = this.padNumber(date.getHours());
        const minutes = this.padNumber(date.getMinutes());

        return (this.settings.filenameDateFormat || 'yyyy-MM-dd')
            .replace(/yyyy/g, year)
            .replace(/MM/g, month)
            .replace(/dd/g, day)
            .replace(/HH/g, hours)
            .replace(/mm/g, minutes);
    }

    private normalizeDateInput(value: string): string {
        let dateStr = (value || '').trim();
        if (dateStr.includes(' ') && !dateStr.includes('T')) {
            dateStr = dateStr.replace(' ', 'T');
        }
        if (!dateStr.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(dateStr)) {
            dateStr += 'Z';
        }
        return dateStr;
    }

    private padNumber(value: number): string {
        return value < 10 ? `0${value}` : String(value);
    }

    private getSourceLabel(task: SyncTask): string {
        const source = (task.content_source || '').toLowerCase();
        if (source.includes('wechat')) return '微信公众号';
        if (source.includes('qq')) return 'QQ';
        if (source.includes('email')) return '邮件';
        if (source.includes('zhihu')) return '知乎';
        return task.content_source || '未知来源';
    }

    private sanitizeFilenameSegment(value: string): string {
        return Array.from(value, char => {
            const code = char.charCodeAt(0);
            return '<>:"/\\|?*'.includes(char) || code < 32 ? '_' : char;
        }).join('').trim().substring(0, 120);
    }

    private normalizePathTemplate(path: string): string {
        const segments = path
            .split('/')
            .map(segment => segment.trim())
            .filter(Boolean)
            .map(segment => this.sanitizeFilenameSegment(segment))
            .filter(segment => segment && segment !== '.' && segment !== '..');
        return segments.join('/');
    }

    private relativeImageUrl(noteFolder: string, imagePath: string): string {
        const noteParts = noteFolder.split('/').filter(Boolean);
        const imageParts = imagePath.split('/').filter(Boolean);
        while (noteParts.length && imageParts.length && noteParts[0] === imageParts[0]) {
            noteParts.shift();
            imageParts.shift();
        }
        const relativeParts = [
            ...noteParts.map(() => '..'),
            ...imageParts.map(part => encodeURIComponent(part).replace(/[()]/g, char => char === '(' ? '%28' : '%29')),
        ];
        const relativePath = relativeParts.join('/');
        return relativeParts[0] === '..' ? relativePath : `./${relativePath}`;
    }

    private hasTaskMarker(content: string, taskId: number): boolean {
        const hasFrontmatter = new RegExp(`task_id:\\s*${taskId}\\b`).test(content);
        const hasComment = new RegExp(`biji-task-id:${taskId}\\b`).test(content);
        const hasMerge = new RegExp(`clip2md-task-start:${taskId}\\b`).test(content);
        return hasFrontmatter || hasComment || hasMerge;
    }

    private hasMappedTaskMarker(content: string, taskId: number): boolean {
        // A daily note contains markers for many tasks. Its own task block must
        // still be intact, even if another task's marker remains in the file.
        if (/<!-- clip2md-task-(?:start|end):\d+ -->/.test(content)) {
            return this.hasMergeBlock(content, taskId);
        }
        return this.hasTaskMarker(content, taskId);
    }

    private buildRequestError(status: number): Error {
        const msg = status === 401
            ? 'API Key 无效，请在 clip2md 网站中重新获取'
            : status === 403
                ? '无权限访问，请检查 API Key'
                : status === 404
                    ? '同步接口不存在'
                    : status === 503
                        ? '服务维护中，稍后会自动重试'
                        : `服务返回错误 (${status})`;
        return new SyncRequestError(msg, status);
    }

    private normalizeRequestError(error: unknown): Error {
        if (error instanceof Error) {
            if (error.message.includes('fetch') || error.message.includes('network')) {
                return new Error('无法连接 Clip2MD 官方服务，请检查网络');
            }
            return error;
        }
        return new Error(String(error));
    }

    private getResponseHeader(headers: Record<string, string> | undefined, name: string): string {
        if (!headers) {
            return '';
        }
        const expected = name.toLowerCase();
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === expected) {
                return headers[key];
            }
        }
        return '';
    }
}
