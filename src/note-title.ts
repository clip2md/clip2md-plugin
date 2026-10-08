import type { SyncTask } from './sync';
import type { BijiSyncSettings } from './settings';

export type TitleMode = 'website' | 'source' | 'task' | 'custom';
const TITLE_VARIABLES = new Set(['title', 'source_title', 'source_title_or_title', 'display_title', 'source', 'date', 'source_date', 'created_at', 'created_date', 'task_id']);
export function validateCustomTitle(template: string): string {
    if (/[\r\n]/.test(template)) return '标题模板只能填写一行。';
    const invalid = [...template.matchAll(/\{\{([^{}]+)\}\}/g)].find(match => !TITLE_VARIABLES.has(match[1]));
    return invalid ? `标题模板不支持 {{${invalid[1]}}}，请使用标题、来源、日期或任务 ID 变量。` : '';
}
export function resolveNoteTitle(settings: BijiSyncSettings, task: SyncTask, source: string, createdDate: string): string {
    const taskTitle = task.title?.trim() || '';
    const original = task.source_title?.trim() || '';
    const website = task.display_title?.trim() || taskTitle || original || `untitled-${task.id}`;
    if (settings.titleMode === 'source') return original || taskTitle || website;
    if (settings.titleMode === 'task') return taskTitle || original || website;
    if (settings.titleMode !== 'custom') return website;
    const template = settings.customTitleTemplate || '';
    if (validateCustomTitle(template)) return website;
    const values: Record<string, string> = {
        title: taskTitle, source_title: original, source_title_or_title: original || taskTitle,
        display_title: website, source, date: task.source_date || '', source_date: task.source_date || '',
        created_at: task.created_at, created_date: createdDate, task_id: String(task.id),
    };
    return template.replace(/\{\{([a-z_]+)\}\}/g, (token, name: string) => values[name] ?? token).trim() || website;
}
