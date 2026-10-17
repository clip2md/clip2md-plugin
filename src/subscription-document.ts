import { parseDocument } from 'yaml';
import { TFolder, type Vault } from 'obsidian';
import { sha256 } from './saved-sync-proof';
import { isArchiveRecord, positiveId, isSubscriptionContext, type SubscriptionContext } from './subscriptions';

export class SubscriptionConflict extends Error {}
type RegionKind = 'cloud' | 'links' | 'index';
export interface ManagedMetadata extends SubscriptionContext { task_id: number; title?: string; url?: string; }
const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
export function documentMetadata(content: string): ManagedMetadata | null {
    const match = frontmatter.exec(content);
    if (!match) return null;
    try {
        const parsed: unknown = parseDocument(match[1]).toJS();
        const value: unknown = isArchiveRecord(parsed) ? parsed.clip2md : undefined;
        return isSubscriptionContext(value) && isArchiveRecord(value) && positiveId(value.task_id)
            && (value.title === undefined || typeof value.title === 'string')
            && (value.url === undefined || typeof value.url === 'string') ? { ...value, task_id: value.task_id } : null;
    } catch { return null; }
}
export function region(content: string, kind: RegionKind, id: number): { full: string; body: string; hash: string } | null {
    const pattern = new RegExp(`<!-- clip2md-${kind}:v1:${id}:([a-f0-9]{64}) -->\\n([\\s\\S]*?)\\n<!-- /clip2md-${kind}:${id} -->`, 'g');
    const matches = [...content.matchAll(pattern)];
    if (matches.length !== 1) return null;
    // Reject duplicate or malformed boundary markers, including nested starts.
    if ((content.match(new RegExp(`<!-- clip2md-${kind}:v1:${id}:`, 'g')) || []).length !== 1
        || (content.match(new RegExp(`<!-- /clip2md-${kind}:${id} -->`, 'g')) || []).length !== 1) return null;
    return { full: matches[0][0], body: matches[0][2], hash: matches[0][1] };
}
export async function managedRegion(kind: RegionKind, id: number, body: string): Promise<string> {
    if (body.includes(`<!-- clip2md-${kind}:v1:${id}:`) || body.includes(`<!-- /clip2md-${kind}:${id} -->`)) {
        throw new SubscriptionConflict('正文含保留的区域标记，请检查模板');
    }
    return `<!-- clip2md-${kind}:v1:${id}:${await sha256(body)} -->\n${body}\n<!-- /clip2md-${kind}:${id} -->`;
}
export async function verifiedRegion(content: string, kind: RegionKind, id: number): Promise<string> {
    const r = region(content, kind, id);
    if (!r || await sha256(r.body) !== r.hash) throw new SubscriptionConflict('受管理区域被编辑或标记损坏，已保留本地内容');
    return r.full;
}
export function withMetadata(content: string, metadata: ManagedMetadata): string {
    const match = frontmatter.exec(content);
    const yaml = parseDocument(match ? match[1] : '');
    if (yaml.errors.length) throw new SubscriptionConflict('笔记属性 YAML 无效，已保留原文件');
    const existing = yaml.get('clip2md');
    if (existing && !documentMetadata(content)) throw new SubscriptionConflict('clip2md 属性已被用户占用');
    const prior = documentMetadata(content);
    if (prior && (prior.account_id !== metadata.account_id || prior.task_id !== metadata.task_id)) {
        throw new SubscriptionConflict('笔记身份与同步任务不一致');
    }
    yaml.set('clip2md', JSON.parse(JSON.stringify(metadata)));
    const header = `---\n${yaml.toString()}---\n`;
    return match ? header + content.slice(match[0].length) : header + '\n' + content;
}
export function stripFrontmatter(content: string): string { return content.replace(frontmatter, ''); }

export async function ensureArchiveFolder(vault: Vault, path: string): Promise<void> {
    let current = '';
    for (const segment of path.split('/').filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment;
        const entry = vault.getAbstractFileByPath(current);
        if (entry && !(entry instanceof TFolder)) throw new Error(`目录被文件占用：${current}`);
        if (!entry) try { await vault.createFolder(current); } catch (error) {
            if (!(vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
        }
    }
}
export async function backupSubscription(vault: Vault, id: number, content: string): Promise<void> {
    await ensureArchiveFolder(vault, '.clip2md-subscription-backups');
    await vault.create(`.clip2md-subscription-backups/${id}-${Date.now()}-${crypto.randomUUID()}.md`, content);
}
