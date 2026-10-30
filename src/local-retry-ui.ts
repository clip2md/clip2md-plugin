import { Modal, Notice, requestUrl } from 'obsidian';
import type BijiSyncPlugin from './main';
import { CLIP2MD_API_BASE_URL } from './config';
import type { LocalRetryResult } from './companion-protocol';
import {
    parseLocalRetryCloudJobs,
    presentLocalRetries,
    type LocalRetryCloudJob,
    type LocalRetryLocalRecord,
} from './local-retry-presentation';
interface RetryRecord {
    taskId: number;
    revision: string;
    key: string;
    result: LocalRetryResult;
    inputId?: string;
    submitted?: boolean;
}

type StoredRetryRecord = RetryRecord & { monitorStatus?: string; error?: string; updatedAt?: string };

async function readLocalRecords(plugin: BijiSyncPlugin, folder: string): Promise<LocalRetryLocalRecord[]> {
    const adapter = plugin.app.vault.adapter;
    if (!await adapter.exists(folder)) return [];
    const files = (await adapter.list(folder)).files
        .filter(file => /\/(?:dispatch-[^/]+|\d+)\.json$/.test(file))
        .slice(-100)
        .reverse();
    const records: LocalRetryLocalRecord[] = [];
    for (const file of files) {
        try {
            const base = JSON.parse(await adapter.read(file)) as StoredRetryRecord;
            const statusFile = `${file}.status.json`;
            const status = await adapter.exists(statusFile)
                ? JSON.parse(await adapter.read(statusFile)) as Partial<StoredRetryRecord>
                : {};
            const record = { ...base, ...status };
            const dispatchId = record.key?.startsWith('dispatch:') ? record.key.split(':')[1] : '';
            const stoppedFile = dispatchId ? `${folder}/dispatch-${dispatchId}.json.stopped` : '';
            let stopped: { reason?: string } = {};
            if (stoppedFile && await adapter.exists(stoppedFile))
                stopped = JSON.parse(await adapter.read(stoppedFile)) as { reason?: string };
            if (!Number.isSafeInteger(record.taskId)) continue;
            records.push({
                taskId: record.taskId,
                kind: /\/dispatch-[^/]+\.json$/.test(file) ? 'dispatch' : 'monitor',
                sourceTitle: record.result?.sourceTitle,
                capturedAt: record.result?.capturedAt,
                updatedAt: record.updatedAt,
                inputId: record.inputId,
                submitted: record.submitted,
                monitorStatus: record.monitorStatus,
                error: record.error,
                stoppedReason: stopped.reason,
            });
        } catch {
            // A damaged local cache must not hide other records or cloud state.
        }
    }
    return records;
}

export async function openLocalRetries(plugin: BijiSyncPlugin): Promise<void> {
    const key = plugin.settings.apiKey, scope = await plugin.companion?.bindingScope();
    if (!key || !scope) { new Notice('请先绑定主插件'); return; }
    if (!plugin.isLocalRetryCurrent(key)) return;
    const modal = new Modal(plugin.app);
    modal.titleEl.setText('本地自动处理记录');
    let alive = true;
    let revision = 0;
    modal.onClose = () => { alive = false; revision++; modal.contentEl.empty(); };
    const intro = modal.contentEl.createEl('p', {
        text: '当前状态以云端为准，本地记录用于补充标题、错误和历史阶段。',
        cls: 'setting-item-description',
    });
    intro.setAttribute('aria-live', 'polite');
    const toolbar = modal.contentEl.createDiv({ cls: 'clip2md-local-retry-toolbar' });
    const refreshButton = toolbar.createEl('button', { text: '刷新', attr: { type: 'button' } });
    const status = modal.contentEl.createEl('p', {
        cls: 'clip2md-local-retry-network setting-item-description',
        attr: { role: 'status', 'aria-live': 'polite' },
    });
    const list = modal.contentEl.createDiv({ cls: 'clip2md-local-retry-list' });

    const render = (local: LocalRetryLocalRecord[], remote: LocalRetryCloudJob[], cloudAvailable: boolean) => {
        const scroll = modal.contentEl.scrollTop;
        const expanded = new Set(Array.from(list.querySelectorAll<HTMLElement>('details[data-task-id][open]')).map(el => el.dataset.taskId || ''));
        list.empty();
        const items = presentLocalRetries(local, remote, cloudAvailable);
        for (const item of items) {
            const row = list.createDiv({ cls: 'clip2md-local-retry-item', attr: { 'data-task-id': String(item.taskId) } });
            const heading = row.createDiv({ cls: 'clip2md-local-retry-heading' });
            heading.createEl('strong', { text: item.title, cls: 'clip2md-local-retry-title' });
            heading.createSpan({ text: item.currentStatus, cls: 'clip2md-local-retry-current' });
            if (item.title !== `任务 #${item.taskId}`)
                row.createDiv({ text: `任务 #${item.taskId}`, cls: 'clip2md-local-retry-task setting-item-description' });
            if (item.error) {
                row.createEl('p', { text: item.error, cls: 'clip2md-local-retry-error' });
            }
            if (item.needsAuthorization) {
                const authorize = row.createEl('button', { text: '打开扩展设置', attr: { type: 'button' } });
                authorize.addEventListener('click', () => {
                    if (alive && plugin.isLocalRetryCurrent(key)) plugin.openDesktopSettings();
                });
            }
            if (item.history.length) {
                const details = row.createEl('details', { cls: 'clip2md-local-retry-history', attr: { 'data-task-id': String(item.taskId) } });
                details.open = expanded.has(String(item.taskId));
                details.createEl('summary', { text: '历史阶段' });
                const history = details.createEl('ul');
                for (const stage of item.history) history.createEl('li', { text: stage });
            }
        }
        if (!items.length) list.createEl('p', {
            text: '暂无自动处理记录。开启 Web 端自动本地解析后，可在这里查看任务进度。',
            cls: 'clip2md-local-retry-empty',
        });
        modal.contentEl.scrollTop = scroll;
    };

    const refresh = async () => {
        if (!alive || !plugin.isLocalRetryCurrent(key)) return;
        const current = ++revision;
        refreshButton.disabled = true;
        list.setAttribute('aria-busy', 'true');
        status.setText('正在读取本地记录并获取云端状态…');
        const valid = () => alive && revision === current && plugin.isLocalRetryCurrent(key);
        const validScope = async () => valid() && await plugin.companion?.bindingScope() === scope && valid();
        try {
            const local = await readLocalRecords(plugin, `${plugin.app.vault.configDir}/clip2md/recovery/${scope}`);
            if (!await validScope()) return;
            let remote: LocalRetryCloudJob[] = [];
            let cloudAvailable = false;
            try {
                const response = await requestUrl({
                    url: `${CLIP2MD_API_BASE_URL}/sync/obsidian/local-recovery/jobs`,
                    headers: { 'X-API-Key': key },
                    throw: false,
                });
                if (!await validScope()) return;
                const parsed = response.status === 200 ? parseLocalRetryCloudJobs(response.json) : null;
                cloudAvailable = parsed !== null;
                remote = parsed || [];
                status.setText(cloudAvailable ? '' : `云端状态获取失败（HTTP ${response.status}），当前状态待联网确认。`);
            } catch {
                if (!await validScope()) return;
                status.setText('无法连接云端，当前状态待联网确认。已保留本地错误和历史详情。');
            }
            if (!await validScope()) return;
            render(local, remote, cloudAvailable);
        } catch {
            if (valid()) {
                list.empty();
                status.setText('记录读取失败，请刷新重试。');
            }
        } finally {
            if (valid()) {
                refreshButton.disabled = false;
                list.setAttribute('aria-busy', 'false');
            }
        }
    };
    refreshButton.addEventListener('click', () => { void refresh(); });
    modal.open();
    await refresh();
}

/** Resume only this binding's accepted submissions; never resubmit or rebill from a timer. */
export async function pollLocalRetries(plugin:BijiSyncPlugin):Promise<void> {
    const key=plugin.settings.apiKey,scope=await plugin.companion?.bindingScope();
    if(!key||!scope)return;
    const folder=`${plugin.app.vault.configDir}/clip2md/recovery/${scope}`;
    if(!(await plugin.app.vault.adapter.exists(folder)))return;
    const records=await plugin.app.vault.adapter.list(folder);
    for(const file of records.files.filter(file=>/\/(?:dispatch-[^/]+|\d+)\.json$/.test(file))) {
        if(!plugin.isLocalRetryCurrent(key))return;
        const statusFile=file+".status.json";
        const value:unknown=JSON.parse(await plugin.app.vault.adapter.read(await plugin.app.vault.adapter.exists(statusFile)?statusFile:file));
        if(!value||typeof value!=='object')continue;
        const record=value as RetryRecord & {monitorStatus?:string};
        if(!record.inputId||!/^[a-zA-Z0-9-]{1,64}$/.test(record.inputId)||!Number.isSafeInteger(record.taskId)||record.monitorStatus)continue;
        const response=await requestUrl({url:`${CLIP2MD_API_BASE_URL}/tasks/${record.taskId}/local-retries/${record.inputId}`,headers:{'X-API-Key':key},throw:false});
        if(!plugin.isLocalRetryCurrent(key))return;
        if(response.status!==200)continue;
        const state=response.json as {submitted:boolean;current:boolean;status:string};
        if(!state.submitted)continue;
        if(!state.current)record.monitorStatus='superseded';
        else if(state.status==='SUCCESS') {
            plugin.syncService.markPending(record.taskId);
            record.monitorStatus='awaiting-local-sync';
            await plugin.saveSettings();
            if(!plugin.isLocalRetryCurrent(key))return;
            if(plugin.getStatusSnapshot().runtimeState!=='syncing')await plugin.syncNow('scheduled');
            new Notice(`任务 #${record.taskId} 智能笔记生成成功，已安排本地同步。`);
        } else if(['FAILED','FAILED_SERVICE_UNAVAILABLE'].includes(state.status)) {
            record.monitorStatus='failed';new Notice(`任务 #${record.taskId} 云端生成失败，原文保留，额度按原规则处理。`);
        }
        await plugin.app.vault.adapter.write(statusFile,JSON.stringify({taskId:record.taskId,inputId:record.inputId,monitorStatus:record.monitorStatus}));
    }
}
