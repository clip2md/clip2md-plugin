import type { App } from 'obsidian';
import type { PendingSyncAck } from './sync-ack';
import type { SyncRunSummary } from './settings';

export const LOCAL_STATE_KEY = 'clip2md-device-state-v1';
export const API_SECRET_ID = 'clip2md-api-key';
export const PENDING_SECRET_ID = 'clip2md-pending-api-key';

export interface PendingBinding {
    deviceCode: string;
    userCode: string;
    expiresAt: number;
    interval: number;
    phase: 'polling' | 'prepared' | 'completed';
    credentialName?: string;
}

export interface LocalDeviceState {
    version: 1;
    installationId: string;
    credentialId?: number;
    credentialName?: string;
    cursor: string | null;
    taskFileMap: Record<number, string>;
    pendingTaskIds: number[];
    ignoredTaskIds: number[];
    pendingAcks: PendingSyncAck[];
    restoreMissingMappedTasksOnNextSync: boolean;
    lastSyncSummary?: SyncRunSummary;
    unresolvedTaskIds: number[];
    legacyKeyMigrated: boolean;
    credentialInvalid?: boolean;
    pendingBinding?: PendingBinding;
}

export function readLocalDeviceState(app: App): LocalDeviceState | null {
    const data: unknown = app.loadLocalStorage(LOCAL_STATE_KEY);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const state = data as Partial<LocalDeviceState>;
    if (state.version !== 1 || typeof state.installationId !== 'string') return null;
    if ((state.cursor !== null && typeof state.cursor !== 'string')
        || !state.taskFileMap || typeof state.taskFileMap !== 'object'
        || Object.values(state.taskFileMap).some(path => typeof path !== 'string')
        || !Array.isArray(state.pendingTaskIds)
        || !Array.isArray(state.ignoredTaskIds)
        || !Array.isArray(state.pendingAcks)
        || !Array.isArray(state.unresolvedTaskIds)
        || (state.credentialInvalid !== undefined && typeof state.credentialInvalid !== 'boolean')) {
        throw new Error('本机同步状态损坏，已暂停同步以避免遗漏任务或误发删除回执');
    }
    if (state.pendingBinding && (typeof state.pendingBinding.deviceCode !== 'string'
        || typeof state.pendingBinding.expiresAt !== 'number'
        || !['polling', 'prepared', 'completed'].includes(state.pendingBinding.phase))) {
        throw new Error('本机绑定状态损坏，已暂停自动领取 Key');
    }
    return state as LocalDeviceState;
}

export function saveLocalDeviceState(app: App, state: LocalDeviceState): void {
    app.saveLocalStorage(LOCAL_STATE_KEY, state);
    const readBack = readLocalDeviceState(app);
    if (!readBack || JSON.stringify(readBack) !== JSON.stringify(state)) {
        throw new Error('本机同步状态保存失败，已停止提交同步回执');
    }
}

export function setLocalSecret(app: App, id: string, value: string): void {
    app.secretStorage.setSecret(id, value);
    if (app.secretStorage.getSecret(id) !== value) {
        throw new Error('本机 API Key 保存失败');
    }
}
