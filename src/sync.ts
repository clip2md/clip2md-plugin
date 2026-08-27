import { FileManager, requestUrl, TFile, Vault } from 'obsidian';
import { BijiSyncSettings, SyncContentMode } from './settings';
import { CLIP2MD_API_BASE_URL } from './config';

export interface SyncTask {
    id: number;
    url: string;
    status: string;
    title: string | null;
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
    pendingAssets?: boolean;
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
        && (value.duration_seconds === null || typeof value.duration_seconds === 'number')
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
}

export class SyncService {
    private settings: BijiSyncSettings;
    private fileManager: FileManager | null;
    private cursor: string | null = null;
    private taskFileMap: TaskFileMapping = {};
    private pendingTaskIds: number[] = [];

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
        this.pendingTaskIds = Array.from(new Set(ids || []));
    }

    getPendingTaskIds(): number[] {
        return this.pendingTaskIds;
    }

    markPending(taskId: number) {
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

    async probeConnection(): Promise<void> {
        await this.fetchTasksPage(null, 1);
    }

    async fetchPendingTasks(): Promise<PendingTaskFetchResult[]> {
        const results = await Promise.all(this.pendingTaskIds.map(async (taskId) => {
            try {
                const response = await requestUrl({
                    url: `${CLIP2MD_API_BASE_URL}/sync/tasks/${taskId}`,
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
                friendly.message = `待重试任务 ${taskId}: ${friendly.message}`;
                throw friendly;
            }
        }));

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

    renderTemplatePreview(template: string): string {
        return this.renderTemplate(template, this.createPreviewTask());
    }

    validateTemplate(template: string): { valid: boolean; message: string } {
        const trimmed = template.trim();
        if (!trimmed) {
            return { valid: false, message: '模板不能为空。' };
        }
        const frontmatterMatch = trimmed.match(/^---\n[\s\S]*?\n---/);
        if (frontmatterMatch) {
            const lines = frontmatterMatch[0].split('\n').slice(1, -1);
            const invalid = lines.find(line => line.trim() && !line.includes(':'));
            if (invalid) {
                return { valid: false, message: `frontmatter 格式可能有误：${invalid}` };
            }
        }
        return { valid: true, message: '' };
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
        template: string
    ): Promise<SyncResult> {
        const localized = await this.localizeTaskImages(vault, task, folderTemplate);
        const localizedTask = localized.task;
        const folder = this.resolveFolderPath(localizedTask, folderTemplate);
        let content = this.renderTemplate(template, localizedTask);
        if (localized.pendingAssets) {
            content = `${content}\n\n> 图片仍在处理中（任务 #${task.id}），稍后会自动重试。`;
        }
        if (localized.failedAssets) {
            content = `${content}\n\n> 部分图片下载失败（任务 #${task.id}），请在 clip2md 网站同步页重试。`;
        }

        if (this.shouldMergeDaily(localizedTask)) {
            return this.renderMergedTask(vault, localizedTask, folder, content, localized.pendingAssets);
        }

        const filename = this.generateFilename(localizedTask);
        const filepath = `${folder}/${filename}`;

        await this.ensureFolder(vault, folder);

        const mappedPath = this.taskFileMap[task.id];
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
                                return { filepath, skipped: false, pendingAssets: localized.pendingAssets };
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
                    return { filepath, skipped: false, pendingAssets: localized.pendingAssets };
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
                return { filepath, skipped: false, pendingAssets: localized.pendingAssets };
            }
            return {
                filepath: null,
                skipped: true,
                reason: `文件 ${filename} 已存在且不含任务标记，已跳过`,
            };
        }

        let createPath = filepath;
        let suffix = 2;
        while (vault.getAbstractFileByPath(createPath)) {
            const ext = '.md';
            const base = filepath.slice(0, -ext.length);
            createPath = `${base} ${suffix}${ext}`;
            suffix += 1;
            if (suffix > 99) break;
        }

        await vault.create(createPath, content);
        this.taskFileMap[task.id] = createPath;
        return { filepath: createPath, skipped: false, pendingAssets: localized.pendingAssets };
    }

    private async fetchTasksPage(cursor: string | null, limit: number): Promise<SyncBatch> {
        const params = new URLSearchParams({ limit: String(limit) });
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
        pendingAssets: boolean,
    ): Promise<SyncResult> {
        await this.ensureFolder(vault, folder);
        const mergedFilename = `${this.formatDateForFilename(task.created_at)}-${this.getSourceLabel(task)}.md`;
        const filepath = `${folder}/${this.sanitizeFilenameSegment(mergedFilename)}`;
        const block = this.buildMergeBlock(task.id, task.title || this.extractTitle(content), content);
        const existing = vault.getFileByPath(filepath);

        if (!existing) {
            const initial = `# ${this.getSourceLabel(task)} · ${this.formatDateForFilename(task.created_at)}\n\n${block}`;
            await vault.create(filepath, initial);
            this.taskFileMap[task.id] = filepath;
            return { filepath, skipped: false, pendingAssets };
        }

        const existingContent = await vault.read(existing);
        const nextContent = this.upsertMergeBlock(existingContent, task.id, block);
        await vault.modify(existing, nextContent);
        this.taskFileMap[task.id] = filepath;
        return { filepath, skipped: false, pendingAssets };
    }

    private buildMergeBlock(taskId: number, title: string, content: string): string {
        return [
            `<!-- clip2md-task-start:${taskId} -->`,
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
            return existing.replace(pattern, block);
        }
        const trimmed = existing.trimEnd();
        return `${trimmed}\n\n${block}\n`;
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
        folderTemplate: string,
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
            };
        }

        const folder = this.resolveFolderPath(task, folderTemplate);
        const imageFolder = `${folder}/_assets/task-${task.id}`;
        let imageFolderReady = false;
        let pendingAssets = false;
        let failedAssets = false;

        const localize = async (markdown: string | null): Promise<string | null> => {
            if (!markdown) {
                return markdown;
            }
            const regex = /!\[([^\]]*)\]\(([^) \t]+)([^)]*)\)/g;
            const replacements = new Map<string, string | null>();
            for (const match of markdown.matchAll(regex)) {
                const remoteUrl = match[2] ?? '';
                if (!remoteUrl.startsWith('/api/v1/assets/')) {
                    continue;
                }
                if (replacements.has(remoteUrl)) {
                    continue;
                }

                try {
                    const response = await requestUrl({
                        url: new URL(remoteUrl, CLIP2MD_API_BASE_URL).toString(),
                        method: 'GET',
                        headers: { 'X-API-Key': this.settings.apiKey },
                        throw: false,
                    });
                    if (response.status < 200 || response.status >= 300) {
                        pendingAssets = true;
                        replacements.set(remoteUrl, null);
                        continue;
                    }
                    const responseType = this.getResponseHeader(response.headers, 'content-type');
                    const assetStatus = this.getResponseHeader(response.headers, 'x-asset-status')
                        || (responseType.startsWith('image/') && !responseType.includes('svg') ? 'READY' : 'PENDING');
                    if (assetStatus === 'PENDING' || assetStatus === 'PROCESSING') {
                        pendingAssets = true;
                        replacements.set(remoteUrl, null);
                        continue;
                    }
                    if (assetStatus === 'FAILED') {
                        failedAssets = true;
                        replacements.set(remoteUrl, null);
                        continue;
                    }

                    const bytes = response.arrayBuffer;
                    const extension = responseType.includes('png') ? 'png'
                        : responseType.includes('webp') ? 'webp'
                        : responseType.includes('gif') ? 'gif'
                        : responseType.includes('avif') ? 'avif'
                        : 'jpg';
                    const safeName = `${this.hash(remoteUrl)}.${extension}`;
                    const path = `${imageFolder}/${safeName}`;
                    if (!imageFolderReady) {
                        await this.ensureFolder(vault, imageFolder);
                        imageFolderReady = true;
                    }
                    if (!vault.getAbstractFileByPath(path)) {
                        await vault.createBinary(path, bytes);
                    }
                    replacements.set(remoteUrl, `./_assets/task-${task.id}/${safeName}`);
                } catch (error) {
                    pendingAssets = true;
                    replacements.set(remoteUrl, null);
                    console.warn(`Clip2MD: 图片下载失败 ${remoteUrl}`, error);
                }
            }

            return markdown.replace(regex, (whole: string) => {
                const match = /^!\[([^\]]*)\]\(([^) \t]+)([^)]*)\)$/.exec(whole);
                if (!match) return whole;
                const altText = match[1] ?? '';
                const remoteUrl = match[2] ?? '';
                const suffix = match[3] ?? '';
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
        };
    }

    private stripImages(markdown: string | null): string | null {
        if (!markdown) {
            return markdown;
        }
        return markdown.replace(/!\[[^\]]*\]\(([^)]+)\)/g, '');
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
        const marker = `<!-- biji-task-id:${task.id} -->`;

        if (mode === 'note') {
            return `${marker}\n\n${noteContent}`;
        }
        if (mode === 'source') {
            return `${marker}\n\n${sourceContent}`;
        }

        if (noteContent && sourceContent) {
            const title = task.title || this.extractTitle(noteContent);
            const fm = this.generateFrontmatter(task, title);
            return `${fm}\n\n${noteContent}\n\n# 原文\n\n${sourceContent}`;
        }
        if (noteContent) {
            return `${marker}\n\n${noteContent}`;
        }
        return `${marker}\n\n${sourceContent}`;
    }

    private generateFrontmatter(task: SyncTask, title: string): string {
        const template = this.settings.frontmatterTemplate;
        const tagsValue = task.tags && task.tags.length > 0
            ? `[${task.tags.map(tag => JSON.stringify(tag.name)).join(', ')}]`
            : '[]';

        if (template && template.trim()) {
            // 使用自定义模板，替换变量
            return template
                .replace(/\{\{title\}\}/g, title.replace(/"/g, '\\"'))
                .replace(/\{\{source_date\}\}/g, task.source_date || '')
                .replace(/\{\{created_at\}\}/g, task.created_at)
                .replace(/\{\{source\}\}/g, this.getSourceLabel(task).replace(/"/g, '\\"'))
                .replace(/\{\{duration\}\}/g, task.duration_seconds ? this.formatDuration(task.duration_seconds) : '')
                .replace(/\{\{content_type\}\}/g, task.content_type || '')
                .replace(/\{\{task_id\}\}/g, String(task.id))
                .replace(/\{\{tags\}\}/g, tagsValue)
                .replace(/\{\{url\}\}/g, task.url || '');
        }

        // 默认格式
        const lines: string[] = ['---'];
        lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
        if (task.source_date) {
            lines.push(`date: "${task.source_date}"`);
        }
        lines.push(`created_at: "${task.created_at}"`);
        lines.push(`source: "${this.getSourceLabel(task).replace(/"/g, '\\"')}"`);
        if (task.duration_seconds) {
            lines.push(`duration: "${this.formatDuration(task.duration_seconds)}"`);
        }
        if (task.content_type) {
            lines.push(`content_type: "${task.content_type}"`);
        }
        if (task.tags && task.tags.length > 0) {
            lines.push('tags:');
            for (const tag of task.tags) {
                lines.push(`  - "${tag.name.replace(/"/g, '\\"')}"`);
            }
        }
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

    private renderTemplate(template: string, task: SyncTask): string {
        const title = task.title || this.extractTitle(task.note_markdown_content || task.source_markdown_content || '');
        const noteContent = task.note_markdown_content || '';
        const sourceContent = task.source_markdown_content || '';
        const content = this.getContentByMode(task);
        const marker = `<!-- biji-task-id:${task.id} -->`;
        const tagsStr = task.tags && task.tags.length > 0 ? task.tags.map(t => t.name).join(', ') : '';

        let result = template
            .replace(/\{\{title\}\}/g, title)
            .replace(/\{\{content\}\}/g, content)
            .replace(/\{\{note_content\}\}/g, noteContent)
            .replace(/\{\{source_content\}\}/g, sourceContent)
            .replace(/\{\{url\}\}/g, task.url)
            .replace(/\{\{date\}\}/g, task.source_date || '')
            .replace(/\{\{created_at\}\}/g, task.created_at)
            .replace(/\{\{created_date\}\}/g, this.formatDateForFilename(task.created_at))
            .replace(/\{\{source\}\}/g, this.getSourceLabel(task))
            .replace(/\{\{duration\}\}/g, task.duration_seconds ? this.formatDuration(task.duration_seconds) : '')
            .replace(/\{\{content_type\}\}/g, task.content_type || '')
            .replace(/\{\{task_id\}\}/g, String(task.id))
            .replace(/\{\{tags\}\}/g, tagsStr);

        if (!this.hasTaskMarker(result, task.id)) {
            result = `${marker}\n\n${result}`;
        }
        return result;
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
            '{{title}}': title || `untitled-${task.id}`,
            '{{date}}': task.source_date || '',
            '{{created_at}}': task.created_at,
            '{{created_date}}': this.formatDateForFilename(task.created_at),
            '{{source}}': this.getSourceLabel(task),
            '{{tags}}': task.tags?.map(tag => tag.name).join(', ') || '',
            '{{task_id}}': String(task.id),
            '{{content_type}}': task.content_type || '',
            '{{url}}': task.url,
        };

        let result = template;
        for (const key of Object.keys(replacements)) {
            const value = replacements[key];
            result = result.replace(new RegExp(this.escapeRegExp(key), 'g'), value);
        }
        return result;
    }

    private formatDateForFilename(dateInput: string): string {
        const date = new Date(this.normalizeDateInput(dateInput));
        const year = String(date.getFullYear());
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');

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

    private hasTaskMarker(content: string, taskId: number): boolean {
        const hasFrontmatter = new RegExp(`task_id:\\s*${taskId}\\b`).test(content);
        const hasComment = new RegExp(`biji-task-id:${taskId}\\b`).test(content);
        const hasMerge = new RegExp(`clip2md-task-start:${taskId}\\b`).test(content);
        return hasFrontmatter || hasComment || hasMerge;
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
        return new Error(msg);
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

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
