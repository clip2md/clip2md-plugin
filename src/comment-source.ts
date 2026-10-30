import { parseDocument } from 'yaml';
import { TFile, type Vault } from 'obsidian';
import { hasTaskId } from './task-id';

export interface CommentSource {
    platform: string; title: string; author: string; url: string | null;
    work_id: string; collected_at: string | null; main_task_id: number | null;
    main_task_title: string; work_record_id: number | null; header_markdown: string;
}
const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const propertyKeys = ['原帖标题', '原帖作者', '原帖链接', '原帖平台', '原帖作品ID', '评论采集时间', '主笔记任务ID', '主笔记网页', '作品详情'];

export function isCommentSource(value: unknown): value is CommentSource {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    return ['platform', 'title', 'author', 'work_id', 'main_task_title', 'header_markdown'].every(k => typeof c[k] === 'string')
        && ['url', 'collected_at'].every(k => c[k] === null || typeof c[k] === 'string')
        && ['main_task_id', 'work_record_id'].every(k => c[k] === null || (Number.isSafeInteger(c[k]) && Number(c[k]) > 0));
}

export function commentProperties(source: CommentSource): Record<string, string | number | null> {
    return { 原帖标题: source.title, 原帖作者: source.author, 原帖链接: source.url,
        原帖平台: source.platform, 原帖作品ID: source.work_id, 评论采集时间: source.collected_at,
        主笔记任务ID: source.main_task_id,
        主笔记网页: source.main_task_id ? `https://clip2.md/app/tasks/${source.main_task_id}` : null,
        作品详情: source.work_record_id ? `https://clip2.md/app/bloggers?work=${source.work_record_id}` : null };
}

export function withCommentProperties(content: string, source: CommentSource, localLink: string | null): string {
    const match = header.exec(content);
    const yaml = parseDocument(match ? match[1] : '');
    if (yaml.errors.length) throw new Error('评论笔记属性 YAML 无效，已保留原文件');
    for (const [key, value] of Object.entries(commentProperties(source))) yaml.set(key, value);
    yaml.set('主笔记', localLink);
    return `---\n${yaml.toString()}---\n` + (match ? content.slice(match[0].length) : '\n' + content);
}

// A stable projection protects the source metadata in deletion receipts while
// allowing Obsidian to update the local link when the target is moved/renamed.
export function savedCommentProperties(content: string): string {
    const match = header.exec(content);
    if (!match) return '';
    try {
        const yaml = parseDocument(match[1]);
        if (yaml.errors.length) return '';
        const values = propertyKeys.map(key => yaml.has(key) ? yaml.get(key) : undefined);
        if (values.some(value => value === undefined)) return '';
        return JSON.stringify(values);
    } catch { return ''; }
}

export async function commentLocalLink(vault: Vault, map: Record<number, string>, id: number | null): Promise<string | null> {
    const path = id ? map[id] : null;
    const file = path ? vault.getFileByPath(path) : null;
    if (!(file instanceof TFile) || /[[\]#|\r\n]/.test(file.path)) return null;
    const content = await vault.read(file);
    // Daily merged notes need an anchored task link, not the entire daily file.
    if (content.includes(`<!-- clip2md-task-start:${id} -->`)) return null;
    if (id === null || !hasTaskId(content, id) || content.includes(`<!-- clip2md-task-start:`)) return null;
    return `[[${file.path.replace(/\.md$/, '')}]]`;
}

export async function refreshCommentLinks(vault: Vault, map: Record<number, string>): Promise<void> {
    for (const [id, path] of Object.entries(map)) {
        const file = vault.getFileByPath(path);
        if (!file) continue;
        const before = await vault.read(file);
        const taskId = Number(id);
        if (!Number.isSafeInteger(taskId) || !hasTaskId(before, taskId) || before.includes(`<!-- clip2md-task-start:`) || !savedCommentProperties(before)) continue;
        const match = header.exec(before)!;
        const yaml = parseDocument(match[1]);
        const targetId = yaml.get('主笔记任务ID');
        if (!Number.isSafeInteger(targetId) || Number(targetId) <= 0) continue;
        const next = await commentLocalLink(vault, map, Number(targetId));
        // Preserve an existing user link; Obsidian manages its rename updates.
        if (!next || yaml.get('主笔记')) continue;
        yaml.set('主笔记', next);
        await vault.process(file, current => current === before
            ? `---\n${yaml.toString()}---\n${current.slice(match[0].length)}` : current);
    }
}
