import { App, MarkdownView, Notice, Plugin, PluginSettingTab, WorkspaceLeaf, addIcon } from 'obsidian';
import {
    BijiSyncSettings,
    BijiSyncSettingTab,
    DEFAULT_FRONTMATTER_TEMPLATE,
    ImageMode,
    LEGACY_DEFAULT_FRONTMATTER_TEMPLATE,
    MergeMode,
    SyncContentMode,
    SyncRunSummary,
    SyncRuntimeState,
    SyncTrigger,
} from './settings';
import { PendingTaskFetchResult, SyncResult, SyncService, SyncTask } from './sync';
import { CLIP2MD_APP_URL, DeviceCredentialStatus } from './binding';
import { CLIP2MD_API_BASE_URL } from './config';
import { sanitizeConfigForBackup } from './config-backup';

const DEFAULT_SETTINGS: BijiSyncSettings = {
    apiKey: '',
    credentialId: undefined,
    credentialName: undefined,
    installationId: '',
    settingsSchemaVersion: 4,
    syncInterval: 60,
    syncOnStart: true,
    targetFolder: '',
    filenameTemplate: '{{created_date}}-{{title}}',
    filenameDateFormat: 'yyyy-MM-dd',
    template: '{{content}}',
    frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
    syncContentMode: 'full',
    imageMode: 'local',
    mergeMode: 'none',
    lastSyncSummary: undefined,
};

const CONFIG_BACKUP_DIR = '.clip2md-config-backup';
const MAX_CONFIG_BACKUPS = 5;
const CONFIG_CORRUPTION_THRESHOLD = 100 * 1024;

type StoredPluginData = Record<string, unknown>;

function isRecord(value: unknown): value is StoredPluginData {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncContentMode(value: unknown): value is SyncContentMode {
    return value === 'full' || value === 'note' || value === 'source';
}

function isImageMode(value: unknown): value is ImageMode {
    return value === 'local' || value === 'disabled';
}

function isMergeMode(value: unknown): value is MergeMode {
    return value === 'none' || value === 'daily';
}

function isSyncRunSummary(value: unknown): value is SyncRunSummary {
    if (!isRecord(value)) return false;
    return typeof value.startedAt === 'string'
        && typeof value.finishedAt === 'string'
        && (value.trigger === 'manual'
            || value.trigger === 'scheduled'
            || value.trigger === 'startup'
            || value.trigger === 'onboarding')
        && (value.outcome === 'success' || value.outcome === 'partial' || value.outcome === 'failed')
        && typeof value.pages === 'number'
        && typeof value.processed === 'number'
        && typeof value.succeeded === 'number'
        && typeof value.pending === 'number'
        && typeof value.skipped === 'number'
        && typeof value.failed === 'number'
        && (value.errorMessage === undefined || typeof value.errorMessage === 'string');
}

function isTaskFileMapping(value: unknown): value is Record<number, string> {
    if (!isRecord(value)) return false;
    return Object.values(value).every(item => typeof item === 'string');
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(item => typeof item === 'number');
}

type ConnectionState = 'unconfigured' | 'configured' | 'connected' | 'error';

interface StatusSnapshot {
    kind: ConnectionState | 'syncing';
    label: string;
    description: string;
    runtimeState: SyncRuntimeState;
}

interface SyncCounters {
    total: number;
    pages: number;
    processed: number;
    succeeded: number;
    pending: number;
    skipped: number;
    failed: number;
}

interface SyncProgress {
    phase: 'idle' | 'discovering' | 'syncing';
    total: number;
    processed: number;
    succeeded: number;
    pending: number;
    skipped: number;
    failed: number;
}

const CLIP2MD_ICON_ID = 'clip2md-logo';
// `addIcon` accepts SVG markup (not only a path fragment).  Keeping the
// viewBox on the registered icon also makes it render correctly when the
// icon is used by an ItemView action, which is stricter than the ribbon API.
const CLIP2MD_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3 18 15v6L6 9V3Z" /></svg>';

export default class BijiSyncPlugin extends Plugin {
    settings: BijiSyncSettings;
    syncService: SyncService;
    syncIntervalId: number | null = null;
    settingTab: BijiSyncSettingTab | null = null;

    private ribbonEl: HTMLElement | null = null;
    private viewActions = new Map<object, { element: HTMLElement; progress: HTMLElement; label: HTMLElement }>();
    private syncNotice: Notice | null = null;
    private syncing = false;
    private runtimeState: SyncRuntimeState = 'idle';
    private processedCount = 0;
    private syncProgress: SyncProgress = {
        phase: 'idle',
        total: 0,
        processed: 0,
        succeeded: 0,
        pending: 0,
        skipped: 0,
        failed: 0,
    };
    private connectionState: ConnectionState = 'unconfigured';
    private connectionMessage = '请填写 API Key 开始使用';
    private startupSyncTriggered = false;

    async onload() {
        let saved: unknown = await this.loadStoredData();
        let savedData = isRecord(saved) ? saved : {};
        const legacyApiUrl = typeof savedData.apiUrl === 'string' ? savedData.apiUrl : '';
        const legacySchemaVersion = typeof savedData.settingsSchemaVersion === 'number'
            ? savedData.settingsSchemaVersion
            : Number(savedData.settingsSchemaVersion || 0);

        if (this.isConfigCorrupted(saved)) {
            console.warn('Clip2MD: 检测到配置文件损坏，尝试从备份恢复...');
            const restored = await this.restoreConfigFromBackup();
            if (restored) {
                saved = restored;
                savedData = restored;
                new Notice('Clip2MD: 配置文件已损坏，已从备份恢复。请检查设置。', 10000);
            } else {
                new Notice('Clip2MD: 配置文件已损坏且无可用备份，请重新配置 API Key。', 10000);
                saved = null;
                savedData = {};
            }
        }

        const hasLegacyVersionSettings = Object.keys(savedData)
            .some(key => key.toLowerCase().includes('update'));

        this.settings = this.normalizeSettings(savedData);
        let settingsMigrated = false;
        if (!this.settings.installationId) {
            this.settings.installationId = this.createInstallationId();
            settingsMigrated = true;
        }
        if (typeof savedData.frontmatterTemplate === 'string'
            && savedData.frontmatterTemplate.trim() === LEGACY_DEFAULT_FRONTMATTER_TEMPLATE.trim()) {
            this.settings.frontmatterTemplate = DEFAULT_FRONTMATTER_TEMPLATE;
            settingsMigrated = true;
        }
        if (legacySchemaVersion < 4
            || Object.prototype.hasOwnProperty.call(savedData, 'apiUrl')
            || hasLegacyVersionSettings) {
            this.settings.settingsSchemaVersion = 4;
            settingsMigrated = true;
        }
        if (settingsMigrated) {
            await this.saveData(this.settings);
        }
        if (legacyApiUrl && legacyApiUrl !== CLIP2MD_API_BASE_URL) {
            new Notice('Clip2MD: 服务地址已统一为官方地址，旧自定义地址不再生效。', 8000);
        }

        if (savedData.syncContentMode === undefined && typeof savedData.apiKey === 'string' && savedData.apiKey) {
            this.settings.syncContentMode = 'source';
        }

        this.syncService = new SyncService(this.settings, this.app.fileManager);

        if (typeof savedData.cursor === 'string') {
            this.syncService.setCursor(savedData.cursor);
        }
        if (isTaskFileMapping(savedData.taskFileMap)) {
            this.syncService.loadTaskFileMap(savedData.taskFileMap);
        }
        if (isNumberArray(savedData.pendingTaskIds)) {
            this.syncService.loadPendingTaskIds(savedData.pendingTaskIds);
        }

        this.updateConnectionState(this.settings.apiKey ? 'configured' : 'unconfigured');

        addIcon(CLIP2MD_ICON_ID, CLIP2MD_ICON_SVG);

        this.settingTab = new BijiSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        this.ribbonEl = this.addRibbonIcon(CLIP2MD_ICON_ID, 'Clip2MD 同步', () => {
            if (!this.settings.apiKey) {
                this.openSettingsTab();
                return;
            }
            void this.syncNow('manual');
        });
        this.updateRibbonState();
        this.app.workspace.iterateAllLeaves(leaf => this.attachViewAction(leaf));
        this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
            if (leaf) {
                this.attachViewAction(leaf);
            }
        }));
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            this.app.workspace.iterateAllLeaves(leaf => this.attachViewAction(leaf));
            this.pruneViewActions();
        }));

        this.addCommand({
            id: 'sync-now',
            name: '立即同步剪藏',
            callback: () => {
                void this.syncNow('manual');
            }
        });


        this.startSyncInterval();
        this.scheduleStartupSync();
    }

    onunload() {
        this.settingTab?.hide();
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }
        this.viewActions.forEach(({ element }) => element.remove());
        this.viewActions.clear();
    }

    async loadSettings() {
        const saved = await this.loadStoredData();
        this.settings = this.normalizeSettings(saved);
        if (saved.syncContentMode === undefined && typeof saved.apiKey === 'string' && saved.apiKey) {
            this.settings.syncContentMode = 'source';
        }

        if (typeof saved.cursor === 'string' && this.syncService) {
            this.syncService.setCursor(saved.cursor);
        }
        if (isTaskFileMapping(saved.taskFileMap) && this.syncService) {
            this.syncService.loadTaskFileMap(saved.taskFileMap);
        }
        if (isNumberArray(saved.pendingTaskIds) && this.syncService) {
            this.syncService.loadPendingTaskIds(saved.pendingTaskIds);
        }
        this.syncService.updateSettings(this.settings);
        this.updateConnectionState(this.settings.apiKey ? 'configured' : 'unconfigured');
        this.updateRibbonState();
    }

    async saveSettings() {
        this.settings = this.normalizeSettings(this.settings);
        await this.saveData(this.settings);
        await this.backupConfig();
        if (this.syncService) {
            this.syncService.updateSettings(this.settings);
        }
        this.startSyncInterval();
        // 不在这里刷新设置页面，避免每次保存都重建 UI
        // 需要刷新时由调用方显式调用 refreshSettingTab()
    }

    async persistSyncState() {
        const data = await this.loadStoredData();
        if (this.syncService) {
            data.cursor = this.syncService.getCursor();
            data.taskFileMap = this.syncService.getTaskFileMap();
            data.pendingTaskIds = this.syncService.getPendingTaskIds();
        }
        data.lastSyncSummary = this.settings.lastSyncSummary;
        await this.saveData(data);
        await this.backupConfig();
    }

    async verifyConnection(): Promise<void> {
        try {
            await this.syncService.probeConnection();
            this.updateConnectionState('connected', '已验证连接');
            this.refreshSettingTab();
        } catch (error) {
            this.handleConnectionError(error);
            throw error;
        }
    }

    handleConnectionError(error: unknown) {
        const message = this.getFriendlyErrorMessage(error);
        this.updateConnectionState('error', message);
        new Notice(`Clip2MD: ${message}`, 8000);
        this.refreshSettingTab();
    }

    getStatusSnapshot(): StatusSnapshot {
        if (!this.settings.apiKey) {
            return {
                kind: 'unconfigured',
                label: '○ 未配置',
                description: '请填写 API Key 开始使用',
                runtimeState: this.runtimeState,
            };
        }

        if (this.runtimeState === 'syncing') {
            const progress = this.syncProgress;
            if (progress.phase === 'discovering') {
                return {
                    kind: 'syncing',
                    label: '◌ 同步中',
                    description: '正在获取待同步任务…',
                    runtimeState: this.runtimeState,
                };
            }
            return {
                kind: 'syncing',
                label: '◌ 同步中',
                description: `本轮已同步 ${progress.succeeded} / ${progress.total}，已处理 ${progress.processed} 项`,
                runtimeState: this.runtimeState,
            };
        }

        const summary = this.settings.lastSyncSummary;
        const summaryText = summary
            ? `上次同步：${this.formatRelativeTime(summary.finishedAt)}，${summary.succeeded} 成功、${summary.pending} 待重试`
            : '尚未执行同步';

        if (this.connectionState === 'connected') {
            return {
                kind: 'connected',
                label: '● 已连接',
                description: summaryText,
                runtimeState: this.runtimeState,
            };
        }

        if (this.connectionState === 'error') {
            return {
                kind: 'error',
                label: '● 连接异常',
                description: this.connectionMessage || summaryText,
                runtimeState: this.runtimeState,
            };
        }

        return {
            kind: 'configured',
            label: '● 已配置',
            description: '本次 Obsidian 会话尚未验证',
            runtimeState: this.runtimeState,
        };
    }

    validateTargetFolder(folder: string): boolean {
        return this.syncService.validateTargetFolder(folder);
    }

    getTemplatePreview() {
        return this.syncService.getTemplatePreviewData();
    }

    renderTemplatePreview() {
        return this.syncService.renderTemplatePreview(this.settings.template);
    }

    validateTemplate(template: string) {
        return this.syncService.validateTemplate(template);
    }

    async applyOnboardingSettings(input: { apiKey: string; targetFolder: string }) {
        this.settings.apiKey = input.apiKey.trim();
        this.settings.targetFolder = input.targetFolder.trim() || 'Clip2MD';
        this.settings.credentialId = undefined;
        this.settings.credentialName = undefined;
        await this.saveSettings();
        await this.verifyConnection();
    }

    async applyDeviceCredential(result: Extract<DeviceCredentialStatus, { status: 'approved' }>): Promise<void> {
        this.settings.apiKey = result.api_key;
        this.settings.credentialId = result.credential_id;
        this.settings.credentialName = result.credential_name;
        if (!this.settings.targetFolder) {
            this.settings.targetFolder = 'Clip2MD';
        }
        await this.saveSettings();
        try {
            await this.verifyConnection();
            new Notice('Clip2MD: 绑定成功，点击“立即同步”开始使用。', 6000);
        } catch {
            new Notice('Clip2MD: API Key 已保存，但连接验证失败，请稍后重试。', 8000);
        }
    }

    getBindingClientName(): string {
        const vaultName = this.app.vault.getName().trim() || 'Vault';
        const suffix = this.settings.installationId.slice(0, 4).toUpperCase();
        return `Obsidian · ${vaultName} (${suffix})`.slice(0, 100);
    }

    openCredentialPage() {
        const query = this.settings.credentialId ? `?credential_id=${this.settings.credentialId}` : '';
        window.open(`${CLIP2MD_APP_URL}/app/sync${query}#api-credentials`, '_blank');
    }

    openSettingsTab() {
        const setting = (this.app as App & {
            setting?: {
                open: () => void;
                openTabById: (id: string) => void;
            };
        }).setting;
        if (setting) {
            setting.open();
            setting.openTabById(this.manifest.id);
        }
    }

    startSyncInterval() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }

        if (!this.settings.apiKey || this.settings.syncInterval === 0) {
            return;
        }

        const intervalMinutes = Math.max(5, this.settings.syncInterval);
        const intervalMs = intervalMinutes * 60 * 1000;
        this.syncIntervalId = window.setInterval(() => {
            void this.syncNow('scheduled');
        }, intervalMs);
    }

    scheduleStartupSync() {
        if (!this.settings.syncOnStart || !this.settings.apiKey) {
            return;
        }
        this.app.workspace.onLayoutReady(() => {
            if (this.startupSyncTriggered) {
                return;
            }
            this.startupSyncTriggered = true;
            window.setTimeout(() => {
                if (!this.settings.apiKey) {
                    return;
                }
                void this.syncNow('startup');
            }, 3000);
        });
    }

    async syncNow(trigger: SyncTrigger = 'manual'): Promise<SyncRunSummary | undefined> {
        if (!this.settings.apiKey) {
            if (trigger === 'manual') {
                this.openSettingsTab();
            }
            return undefined;
        }

        if (!this.settings.targetFolder) {
            if (trigger === 'manual') {
                new Notice('Clip2MD: 请先在设置中配置目标文件夹', 5000);
                this.openSettingsTab();
            }
            return undefined;
        }

        if (this.syncing) {
            if (trigger === 'manual') {
                new Notice('Clip2MD: 同步正在进行中', 4000);
            }
            return this.settings.lastSyncSummary;
        }

        this.syncing = true;
        this.runtimeState = 'syncing';
        this.processedCount = 0;
        this.syncProgress = {
            phase: 'discovering',
            total: 0,
            processed: 0,
            succeeded: 0,
            pending: 0,
            skipped: 0,
            failed: 0,
        };
        this.updateRibbonState();
        this.updateViewActions();
        this.refreshSettingTab();
        this.startSyncProgressNotice();

        const startedAt = new Date().toISOString();
        const counters: SyncCounters = { total: 0, pages: 0, processed: 0, succeeded: 0, pending: 0, skipped: 0, failed: 0 };
        const processedTaskIds = new Set<number>();

        try {
            const pendingTasks = await this.syncService.fetchPendingTasks();
            let cursor = this.syncService.getCursor();
            let batch = await this.syncService.fetchNextPage(cursor);
            counters.total = pendingTasks.reduce((count, item) => count + (item.task ? 1 : 0), 0) + batch.total;
            this.updateSyncProgress(counters, 'syncing');
            this.refreshSettingTab();

            await this.processPendingQueue(pendingTasks, processedTaskIds, counters);

            let hasMore = true;
            while (hasMore) {
                counters.pages += 1;
                const deduped = batch.tasks.filter(task => {
                    if (processedTaskIds.has(task.id)) {
                        return false;
                    }
                    processedTaskIds.add(task.id);
                    return true;
                });
                const duplicateCount = batch.tasks.length - deduped.length;
                if (duplicateCount > 0) {
                    counters.total = Math.max(counters.processed, counters.total - duplicateCount);
                    this.updateSyncProgress(counters, 'syncing');
                }

                await this.processTasks(deduped, counters);
                this.processedCount = counters.processed;

                const previousCursor = this.syncService.getCursor();
                const nextCursor = batch.nextCursor;
                if (batch.hasMore && (!nextCursor || nextCursor === cursor)) {
                    throw new Error('同步游标未推进，已停止以避免无限循环');
                }

                this.syncService.setCursor(nextCursor);
                try {
                    await this.persistSyncState();
                } catch (error) {
                    this.syncService.setCursor(previousCursor);
                    throw error;
                }

                cursor = nextCursor;
                hasMore = batch.hasMore;
                if (hasMore) {
                    batch = await this.syncService.fetchNextPage(cursor);
                }
            }

            const outcome = counters.failed > 0
                ? 'failed'
                : (counters.pending > 0 || counters.skipped > 0 ? 'partial' : 'success');
            const summary = this.finishSyncRun({
                startedAt,
                finishedAt: new Date().toISOString(),
                trigger,
                outcome,
                pages: counters.pages,
                processed: counters.processed,
                succeeded: counters.succeeded,
                pending: counters.pending,
                skipped: counters.skipped,
                failed: counters.failed,
            });

            this.updateConnectionState('connected', '已验证连接');
            this.completeSyncProgressNotice(summary);
            return summary;
        } catch (error) {
            const message = this.getFriendlyErrorMessage(error);
            console.error('Clip2MD 同步出错:', error);
            this.updateConnectionState('error', message);
            const summary = this.finishSyncRun({
                startedAt,
                finishedAt: new Date().toISOString(),
                trigger,
                outcome: 'failed',
                pages: counters.pages,
                processed: counters.processed,
                succeeded: counters.succeeded,
                pending: counters.pending,
                skipped: counters.skipped,
                failed: counters.failed + 1,
                errorMessage: message,
            });

            this.failSyncProgressNotice(message);
            return summary;
        } finally {
            this.syncing = false;
            this.processedCount = 0;
            this.syncProgress = {
                phase: 'idle',
                total: 0,
                processed: 0,
                succeeded: 0,
                pending: 0,
                skipped: 0,
                failed: 0,
            };
            if (this.runtimeState === 'syncing') {
                this.runtimeState = this.connectionState === 'error' ? 'error' : 'idle';
            }
            if (this.syncNotice) {
                this.syncNotice.hide();
                this.syncNotice = null;
            }
            this.updateRibbonState();
            this.updateViewActions();
            this.refreshSettingTab();
        }
    }

    isConfigCorrupted(data: unknown): boolean {
        if (data === null || data === undefined) return false;
        if (!isRecord(data)) return true;

        try {
            const jsonStr = JSON.stringify(data);
            const jsonLength = jsonStr?.length ?? 0;
            if (!jsonStr || jsonLength > CONFIG_CORRUPTION_THRESHOLD) {
                console.warn(`Clip2MD: 配置文件过大 (${jsonLength} bytes)，视为损坏`);
                return true;
            }
        } catch {
            return true;
        }

        if (data.apiKey !== undefined && typeof data.apiKey !== 'string') return true;
        if (data.targetFolder !== undefined && typeof data.targetFolder !== 'string') return true;
        if (data.syncInterval !== undefined && typeof data.syncInterval !== 'number') return true;

        return false;
    }

    async backupConfig(): Promise<void> {
        try {
            const data = await this.loadStoredData();

            const backupBaseDir = `${this.app.vault.configDir}/${CONFIG_BACKUP_DIR}`;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = `${backupBaseDir}/config-${timestamp}.json`;

            try {
                await this.app.vault.adapter.mkdir(backupBaseDir);
            } catch {
                // ignore
            }

            await this.app.vault.adapter.write(backupPath, JSON.stringify(sanitizeConfigForBackup(data), null, 2));
            await this.cleanupOldConfigBackups(backupBaseDir);
        } catch (error) {
            console.warn('Clip2MD: 配置备份失败', error);
        }
    }

    async restoreConfigFromBackup(): Promise<StoredPluginData | null> {
        try {
            const backupBaseDir = `${this.app.vault.configDir}/${CONFIG_BACKUP_DIR}`;
            const listing = await this.app.vault.adapter.list(backupBaseDir);
            const files = listing.files
                .map(f => f.split('/').pop() || '')
                .filter(f => f.startsWith('config-') && f.endsWith('.json'))
                .sort();

            if (files.length === 0) return null;

            const latestBackup = files[files.length - 1];
            const content = await this.app.vault.adapter.read(`${backupBaseDir}/${latestBackup}`);
            const restored: unknown = JSON.parse(content);
            return isRecord(restored) ? restored : null;
        } catch (error) {
            console.warn('Clip2MD: 从备份恢复配置失败', error);
            return null;
        }
    }

    async cleanupOldConfigBackups(backupBaseDir: string): Promise<void> {
        try {
            const listing = await this.app.vault.adapter.list(backupBaseDir);
            const files = listing.files
                .map(f => f.split('/').pop() || '')
                .filter(f => f.startsWith('config-') && f.endsWith('.json'))
                .sort();

            if (files.length > MAX_CONFIG_BACKUPS) {
                const toDelete = files.slice(0, files.length - MAX_CONFIG_BACKUPS);
                for (const file of toDelete) {
                    await this.app.vault.adapter.remove(`${backupBaseDir}/${file}`);
                }
            }
        } catch (error) {
            console.warn('Clip2MD: 清理旧配置备份失败', error);
        }
    }

    private async processPendingQueue(
        pendingTasks: PendingTaskFetchResult[],
        processedTaskIds: Set<number>,
        counters: SyncCounters,
    ) {
        for (const item of pendingTasks) {
            if (item.missing) {
                this.syncService.removePending(item.taskId);
                await this.persistSyncState();
                continue;
            }
            if (!item.task) {
                continue;
            }
            if (processedTaskIds.has(item.task.id)) {
                continue;
            }
            processedTaskIds.add(item.task.id);
            await this.processTasks([item.task], counters);
        }
    }

    private async processTasks(tasks: SyncTask[], counters: SyncCounters) {
        for (const task of tasks) {
            counters.processed += 1;
            this.processedCount = counters.processed;

            let result: SyncResult;
            try {
                result = await this.syncService.renderToVault(
                    this.app.vault,
                    task,
                    this.settings.targetFolder,
                    this.settings.template,
                );
            } catch (error) {
                this.syncService.markPending(task.id);
                counters.pending += 1;
                console.error(`Clip2MD: 任务 ${task.id} 同步失败`, error);
                this.updateSyncProgress(counters, 'syncing');
                continue;
            }

            if (result.skipped) {
                this.syncService.markPending(task.id);
                counters.skipped += 1;
                console.warn(`Clip2MD: 任务 ${task.id} 已跳过: ${result.reason}`);
            } else if (result.pendingAssets) {
                this.syncService.markPending(task.id);
                counters.pending += 1;
            } else {
                this.syncService.markComplete(task.id);
                counters.succeeded += 1;
            }
            this.updateSyncProgress(counters, 'syncing');
        }
    }

    private finishSyncRun(summary: SyncRunSummary): SyncRunSummary {
        this.settings.lastSyncSummary = summary;
        this.runtimeState = summary.outcome === 'failed'
            ? 'error'
            : summary.outcome === 'partial'
                ? 'partial'
                : 'success';
        void this.saveSettings();
        return summary;
    }

    private updateConnectionState(state: ConnectionState, message?: string) {
        this.connectionState = state;
        if (state === 'unconfigured') {
            this.connectionMessage = '请填写 API Key 开始使用';
        } else if (state === 'configured') {
            this.connectionMessage = '本次 Obsidian 会话尚未验证';
        } else if (message) {
            this.connectionMessage = message;
        } else if (state === 'connected') {
            this.connectionMessage = '已验证连接';
        }
    }

    private updateRibbonState() {
        if (!this.ribbonEl) {
            return;
        }
        this.ribbonEl.removeClass('clip2md-ribbon-loading');
        const label = this.syncing
            ? this.syncProgress.phase === 'discovering'
                ? 'Clip2MD：正在获取同步任务'
                : `Clip2MD：已同步 ${this.syncProgress.succeeded} / ${this.syncProgress.total}`
            : 'Clip2MD 同步';
        this.ribbonEl.setAttr('aria-label', label);
        this.ribbonEl.setAttr('title', label);
        if (this.syncing) {
            this.ribbonEl.addClass('clip2md-ribbon-loading');
        }
    }

    private attachViewAction(leaf: WorkspaceLeaf) {
        const view = leaf.view;
        if (!this.isMarkdownView(view) || this.viewActions.has(view)) {
            return;
        }

        const action = view.addAction(CLIP2MD_ICON_ID, 'Clip2MD 同步', () => {
            if (!this.settings.apiKey) {
                this.openSettingsTab();
                return;
            }
            void this.syncNow('manual');
        });
        action.addClass('clip2md-view-action');
        const progress = action.createSpan({ cls: 'clip2md-view-action-progress' });
        const label = action.createSpan({ cls: 'clip2md-view-action-label' });
        this.viewActions.set(view, { element: action, progress, label });
        this.updateViewAction(view, action, progress, label);
    }

    private isMarkdownView(view: unknown): view is MarkdownView {
        if (view instanceof MarkdownView) {
            return true;
        }
        // Views created in a pop-out window can come from a different
        // JavaScript realm, so `instanceof MarkdownView` is not reliable.
        return typeof (view as { getViewType?: unknown } | null)?.getViewType === 'function'
            && (view as { getViewType: () => string }).getViewType() === 'markdown'
            && typeof (view as { addAction?: unknown }).addAction === 'function';
    }

    private pruneViewActions() {
        this.viewActions.forEach(({ element }, view) => {
            if (!element.isConnected) {
                this.viewActions.delete(view);
            }
        });
    }

    private updateViewAction(_view: object, action: HTMLElement, progress: HTMLElement, label: HTMLElement) {
        action.toggleClass('is-syncing', this.syncing);
        const text = !this.syncing
            ? ''
            : this.syncProgress.phase === 'discovering'
                ? '获取中…'
                : `${this.syncProgress.succeeded}/${this.syncProgress.total}`;
        label.setText(text);
        progress.setText(this.syncing ? this.renderProgressBlocks() : '');
        const tooltip = !this.syncing
            ? 'Clip2MD 同步'
            : this.syncProgress.phase === 'discovering'
                ? 'Clip2MD：正在获取待同步任务'
                : `Clip2MD：已同步 ${this.syncProgress.succeeded}/${this.syncProgress.total}，已处理 ${this.syncProgress.processed} 项，${this.syncProgress.pending} 待重试，${this.syncProgress.skipped} 跳过，${this.syncProgress.failed} 失败`;
        action.setAttr('aria-label', tooltip);
        action.setAttr('title', tooltip);
    }

    private updateViewActions() {
        this.viewActions.forEach(({ element, progress, label }, view) => this.updateViewAction(view, element, progress, label));
    }

    private startSyncProgressNotice() {
        this.syncNotice?.hide();
        this.syncNotice = new Notice('', 0);
        this.updateSyncProgressNotice('正在获取任务…');
    }

    private completeSyncProgressNotice(summary: SyncRunSummary) {
        if (!this.syncNotice) {
            return;
        }
        this.syncNotice.setMessage(`${'■ '.repeat(5).trim()}  同步完成！${summary.succeeded} 篇文章`);
        const notice = this.syncNotice;
        window.setTimeout(() => notice.hide(), 3000);
        this.syncNotice = null;
    }

    private failSyncProgressNotice(message: string) {
        if (!this.syncNotice) {
            return;
        }
        this.syncNotice.setMessage(`${'□ '.repeat(5).trim()}  ${message}`);
        const notice = this.syncNotice;
        window.setTimeout(() => notice.hide(), 5000);
        this.syncNotice = null;
    }

    private updateSyncProgressNotice(message: string) {
        if (!this.syncNotice) {
            return;
        }
        this.syncNotice.setMessage(`${this.renderProgressBlocks()}  ${message}`);
    }

    private renderProgressBlocks(): string {
        const blocks = 5;
        if (this.syncProgress.phase === 'discovering') {
            return `■${' □'.repeat(blocks - 1)}`;
        }

        const total = Math.max(this.syncProgress.total, 1);
        const processed = Math.min(
            total,
            this.syncProgress.succeeded
                + this.syncProgress.pending
                + this.syncProgress.skipped
                + this.syncProgress.failed,
        );
        const filled = Math.min(blocks, Math.max(0, Math.round((processed / total) * blocks)));
        return `${'■ '.repeat(filled)}${'□ '.repeat(blocks - filled)}`.trim();
    }

    private updateSyncProgress(counters: SyncCounters, phase: SyncProgress['phase']) {
        this.syncProgress = {
            phase,
            total: counters.total,
            processed: counters.processed,
            succeeded: counters.succeeded,
            pending: counters.pending,
            skipped: counters.skipped,
            failed: counters.failed,
        };
        this.processedCount = counters.processed;
        this.updateRibbonState();
        this.updateViewActions();
        this.updateSyncProgressNotice(`已处理 ${counters.processed}/${Math.max(counters.total, 0)} 项`);
    }

    private refreshSettingTab() {
        const openTab = ((this.app as App & { setting?: { activeTab?: PluginSettingTab } }).setting?.activeTab);
        if (openTab === this.settingTab) {
            this.settingTab?.refresh();
        }
    }

    private async loadStoredData(): Promise<StoredPluginData> {
        const data = await this.loadData() as unknown;
        return isRecord(data) ? data : {};
    }

    private normalizeSettings(settings: BijiSyncSettings | StoredPluginData): BijiSyncSettings {
        const rawInterval = typeof settings.syncInterval === 'number' ? settings.syncInterval : 60;
        const normalizedInterval = rawInterval === 0 ? 0 : Math.max(5, rawInterval || 60);
        const frontmatterTemplate = typeof settings.frontmatterTemplate === 'string'
            ? settings.frontmatterTemplate
            : DEFAULT_FRONTMATTER_TEMPLATE;
        return {
            apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : '',
            credentialId: typeof settings.credentialId === 'number' ? settings.credentialId : undefined,
            credentialName: typeof settings.credentialName === 'string' ? settings.credentialName : undefined,
            installationId: typeof settings.installationId === 'string' ? settings.installationId : '',
            settingsSchemaVersion: 4,
            syncInterval: normalizedInterval,
            syncOnStart: settings.syncOnStart !== false,
            targetFolder: typeof settings.targetFolder === 'string' ? settings.targetFolder : '',
            filenameTemplate: typeof settings.filenameTemplate === 'string' && settings.filenameTemplate
                ? settings.filenameTemplate
                : '{{created_date}}-{{title}}',
            filenameDateFormat: typeof settings.filenameDateFormat === 'string' && settings.filenameDateFormat
                ? settings.filenameDateFormat
                : 'yyyy-MM-dd',
            template: typeof settings.template === 'string' ? settings.template : '{{content}}',
            frontmatterTemplate: frontmatterTemplate.trim() === LEGACY_DEFAULT_FRONTMATTER_TEMPLATE.trim()
                ? DEFAULT_FRONTMATTER_TEMPLATE
                : frontmatterTemplate,
            syncContentMode: isSyncContentMode(settings.syncContentMode) ? settings.syncContentMode : 'full',
            imageMode: isImageMode(settings.imageMode) ? settings.imageMode : 'local',
            mergeMode: isMergeMode(settings.mergeMode) ? settings.mergeMode : 'none',
            lastSyncSummary: isSyncRunSummary(settings.lastSyncSummary)
                ? settings.lastSyncSummary
                : undefined,
        };
    }

    private createInstallationId(): string {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID().replace(/-/g, '');
        }
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
    }

    private getFriendlyErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            if (error.message.includes('fetch') || error.message.includes('network')) {
                return '无法连接 Clip2MD 官方服务，请检查网络';
            }
            return error.message;
        }
        return String(error);
    }

    private formatRelativeTime(dateInput: string): string {
        const diffMs = Date.now() - new Date(dateInput).getTime();
        const diffMinutes = Math.round(diffMs / 60000);
        if (diffMinutes < 1) return '刚刚';
        if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
        const diffHours = Math.round(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours} 小时前`;
        const diffDays = Math.round(diffHours / 24);
        return `${diffDays} 天前`;
    }
}
